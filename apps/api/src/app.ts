import { APPOINTMENT_STATUSES, SESSION_COOKIE_NAME } from "@medibun/api-client";
import type {
  AppointmentStatus,
  BookedAppointment,
  BookingRequest,
  DaySheet,
  PatientProfile,
  ServiceAvailability,
  ServiceSummary,
  StaffProfile,
} from "@medibun/api-client";
import {
  ForbiddenError,
  InvalidCredentialsError,
  MfaRequiredError,
  MultipleMembershipsError,
  SessionExpiredError,
  SlotTakenError,
  StatusConflictError,
} from "@medibun/medplum-backend";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { InvalidSlotError, UnknownScheduleError, UnknownServiceError } from "./booking.js";
import { InvalidTransitionError, isValidDateString, UnknownAppointmentError } from "./staff.js";

/**
 * @medibun/api — the BFF (ADR-0001). The only consumer of @medibun/medplum-backend;
 * product apps reach it exclusively through @medibun/api-client.
 *
 * PHI-safety invariants enforced here (see .claude/rules/security.md):
 * - Request logs carry identifiers only: request id, method, path, status, duration.
 *   Never the query string, body, or headers — any of them may carry PHI.
 * - Client-facing error bodies are generic codes + request id. Error messages are
 *   never sent to clients and must never interpolate PHI values at throw sites.
 */

export type LogEntry = {
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  /** Middleware-set diagnostic (e.g. the rejected Origin header). Never PHI. */
  readonly detail?: string;
};

export type AuthDeps = {
  /** Brokered Medplum direct login → opaque session id. Throws InvalidCredentialsError. */
  readonly login: (email: string, password: string) => Promise<{ sessionId: string }>;
  readonly logout: (sessionId: string) => Promise<void>;
  readonly getUser: (
    sessionId: string,
  ) => Promise<{ profileReference: string; accessToken: string } | null>;
  /** Reads the session user's own patient profile AS that user (their Medplum token). */
  readonly getMyProfile: (user: {
    profileReference: string;
    accessToken: string;
  }) => Promise<PatientProfile | undefined>;
  /** Atomically record the attempt and return whether the IP is now rate-limited. */
  readonly recordAndCheckRateLimit: (ip: string) => Promise<boolean>;
  /**
   * Trusted client-IP resolver for rate-limit buckets. UNSET = every request shares
   * the "direct" bucket and x-forwarded-for is IGNORED (it is client-controlled;
   * the leftmost entry can be spoofed). Wire one only from a header the deployment
   * platform overwrites (e.g. x-real-ip on Vercel) or from the socket address.
   */
  readonly clientIp?: (req: { header: (name: string) => string | undefined }) => string;
  /** Browser origins allowed to hit mutating auth routes. Default: none. */
  readonly allowedOrigins?: readonly string[];
  /** Secure cookie flag — defaults to true; opt out only for local-http dev. */
  readonly cookieSecure?: boolean;
};

export type BookingDeps = {
  /** The active service menu (catalog data — no PHI). */
  readonly listServices: () => Promise<ServiceSummary[]>;
  /** Availability per practitioner. Throws UnknownServiceError for unknown codes. */
  readonly getAvailability: (serviceCode: string) => Promise<ServiceAvailability>;
  /** Books for the session patient. Throws SlotTakenError / UnknownServiceError /
   *  UnknownScheduleError / InvalidSlotError. */
  readonly book: (patientReference: string, request: BookingRequest) => Promise<BookedAppointment>;
};

/** Staff routes run AS THE SIGNED-IN STAFF MEMBER (their Medplum token) — AccessPolicy
 *  enforcement and audit attribution are the core's, not re-implemented here. */
export type StaffDeps = {
  readonly getStaffProfile: (user: {
    profileReference: string;
    accessToken: string;
  }) => Promise<StaffProfile | undefined>;
  readonly getDaySheet: (
    user: { profileReference: string; accessToken: string },
    date?: string,
    days?: number,
  ) => Promise<DaySheet>;
  /** Throws InvalidTransitionError / UnknownAppointmentError / StatusConflictError. */
  readonly setAppointmentStatus: (
    user: { profileReference: string; accessToken: string },
    appointmentId: string,
    status: AppointmentStatus,
  ) => Promise<{ id: string; status: AppointmentStatus }>;
};

export type AppDeps = {
  readonly log: (entry: LogEntry) => void;
  /** Resolves true when Medplum is reachable and credentials are valid. */
  readonly checkMedplum: () => Promise<boolean>;
  /** Auth routes mount only when provided (docs/AUTH.md). */
  readonly auth?: AuthDeps;
  /** Booking routes mount only when provided ALONG WITH auth (sessions gate them). */
  readonly booking?: BookingDeps;
  /** Staff routes mount only when provided ALONG WITH auth (sessions gate them). */
  readonly staff?: StaffDeps;
};

type Env = { Variables: { requestId: string; logDetail?: string } };

/**
 * The BFF's public error-code contract. Every client-facing error body is exactly
 * `{ error: <ErrorCode>, requestId }` — a generic code plus a correlation id, never a
 * message or PHI (see the PHI-safety invariant above). Enumerated so the contract is
 * greppable and typo-proof.
 */
type ErrorCode =
  | "internal_error"
  | "not_found"
  | "invalid_request"
  | "rate_limited"
  | "invalid_credentials"
  | "mfa_not_supported"
  | "membership_selection_not_supported"
  | "forbidden_origin"
  | "unauthorized"
  | "forbidden"
  | "slot_taken"
  | "conflict";

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();

  /** PHI-safe error response: generic code + request id, nothing else. */
  const fail = (c: Context<Env>, error: ErrorCode, status: ContentfulStatusCode) =>
    c.json({ error, requestId: c.get("requestId") }, status);

  app.use(async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    const start = performance.now();
    await next();
    deps.log({
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: performance.now() - start,
      detail: c.get("logDetail"),
    });
  });

  app.onError((_err, c) => fail(c, "internal_error", 500));

  app.notFound((c) => fail(c, "not_found", 404));

  app.get("/health", (c) => c.json({ status: "ok" }));

  const auth = deps.auth;
  if (auth) {
    const cookieOpts = {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      secure: auth.cookieSecure ?? true,
    } as const;

    // CSRF defense that doesn't depend on SameSite (docs/AUTH.md): browser-sent
    // Origins must be allowlisted on mutating cookie-authenticated routes. No Origin
    // (curl, mobile, server-to-server) passes — the cookie isn't attached there anyway.
    const allowedOrigins = new Set(auth.allowedOrigins ?? []);
    const originGuard = async (c: Context<Env>, next: () => Promise<void>) => {
      const origin = c.req.header("Origin");
      if (c.req.method !== "GET" && origin && !allowedOrigins.has(origin)) {
        // Origins are browser/config values, never PHI — log the mismatch so a
        // misconfigured allowlist is diagnosable from the server output alone.
        c.set("logDetail", `origin rejected: ${origin}`);
        return fail(c, "forbidden_origin", 403);
      }
      await next();
    };
    // Registered globally, not per-path: every mutating route this app ever mounts is
    // covered fail-closed the day it lands, instead of a hand-maintained path list.
    // GETs and Origin-less requests (curl, mobile bearer, server-to-server) pass.
    app.use(originGuard);

    const clientIp = (c: { req: { header: (name: string) => string | undefined } }) =>
      auth.clientIp ? auth.clientIp(c.req) : "direct";

    // Resolve the session id from a Bearer header (mobile) or the cookie (web), in that
    // order. Returns undefined when neither yields a non-empty id — so an empty/malformed
    // bearer can't shadow a valid cookie.
    const resolveSessionId = (c: Context<Env>): string | undefined => {
      const bearer = c.req.header("Authorization");
      if (bearer?.startsWith("Bearer ")) {
        const token = bearer.slice("Bearer ".length);
        if (token) {
          return token;
        }
      }
      return getCookie(c, SESSION_COOKIE_NAME) || undefined;
    };

    // NOTE (PHI safety): the request logger never logs bodies, so credentials in the
    // login payload stay out of logs by construction. Do not add body logging.
    app.post("/auth/login", async (c) => {
      // ?? {} — a literal `null` body parses successfully, so the catch can't cover it.
      const body = ((await c.req.json().catch(() => ({}))) ?? {}) as {
        email?: string;
        password?: string;
      };
      if (!body.email || !body.password) {
        return fail(c, "invalid_request", 400);
      }
      const ip = clientIp(c);
      if (await auth.recordAndCheckRateLimit(ip)) {
        return fail(c, "rate_limited", 429);
      }
      try {
        const { sessionId } = await auth.login(body.email, body.password);
        setCookie(c, SESSION_COOKIE_NAME, sessionId, cookieOpts);
        return c.json({ sessionToken: sessionId });
      } catch (err) {
        if (err instanceof InvalidCredentialsError) {
          return fail(c, "invalid_credentials", 401);
        }
        // Recognized-but-unimplemented Medplum login branches: a clean 501, not a 500.
        // The MFA verify/enroll flow and membership selection are their own PRs (AUTH.md).
        if (err instanceof MfaRequiredError) {
          return fail(c, "mfa_not_supported", 501);
        }
        if (err instanceof MultipleMembershipsError) {
          return fail(c, "membership_selection_not_supported", 501);
        }
        throw err;
      }
    });

    app.post("/auth/logout", async (c) => {
      const sessionId = resolveSessionId(c);
      if (sessionId) {
        // Logout must always clear the client's cookie and report success: a failure in
        // upstream (best-effort) revocation must not strand the user in a logged-in UI.
        await auth.logout(sessionId).catch(() => undefined);
      }
      deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
      return c.json({ ok: true });
    });

    /** The session's authenticated user, or null (routes answer 401 themselves). */
    const sessionUser = async (c: Context<Env>) => {
      const sessionId = resolveSessionId(c);
      return sessionId ? await auth.getUser(sessionId) : null;
    };

    app.get("/patients/me", async (c) => {
      const user = await sessionUser(c);
      if (!user) {
        return fail(c, "unauthorized", 401);
      }
      let profile;
      try {
        profile = await auth.getMyProfile(user);
      } catch (err) {
        // The user's Medplum token was rejected upstream (expired/revoked between
        // session validation and the read) — a 401 to re-authenticate, not a 500.
        if (err instanceof SessionExpiredError) {
          return fail(c, "unauthorized", 401);
        }
        throw err;
      }
      if (!profile) {
        return fail(c, "not_found", 404);
      }
      return c.json(profile);
    });

    // Booking (S4). Sessions gate every route; the scheduling calls run under the BFF's
    // service client per DATA_MODEL.md ("book via BFF") — see src/booking.ts for the
    // principal rationale. Nothing here logs or returns another patient's data: the
    // service menu and availability are PHI-free, and $book is bound to the session's
    // own patient reference server-side.
    const booking = deps.booking;
    if (booking) {
      app.get("/services", async (c) => {
        if (!(await sessionUser(c))) {
          return fail(c, "unauthorized", 401);
        }
        return c.json({ services: await booking.listServices() });
      });

      app.get("/services/:code/availability", async (c) => {
        if (!(await sessionUser(c))) {
          return fail(c, "unauthorized", 401);
        }
        try {
          return c.json(await booking.getAvailability(c.req.param("code")));
        } catch (err) {
          if (err instanceof UnknownServiceError) {
            return fail(c, "not_found", 404);
          }
          throw err;
        }
      });

      app.post("/appointments", async (c) => {
        const user = await sessionUser(c);
        if (!user) {
          return fail(c, "unauthorized", 401);
        }
        // Patients book for themselves only. A non-patient principal has no
        // self-booking semantics — staff booking arrives with the staff app (S11).
        if (!user.profileReference.startsWith("Patient/")) {
          return fail(c, "forbidden", 403);
        }
        // ?? {} — a literal `null` body parses successfully, so the catch can't cover it.
        const body = ((await c.req.json().catch(() => ({}))) ?? {}) as {
          serviceCode?: unknown;
          scheduleId?: unknown;
          start?: unknown;
        };
        const { serviceCode, scheduleId, start } = body;
        if (
          typeof serviceCode !== "string" ||
          !serviceCode ||
          typeof scheduleId !== "string" ||
          !scheduleId ||
          typeof start !== "string" ||
          !start
        ) {
          return fail(c, "invalid_request", 400);
        }
        try {
          const appointment = await booking.book(user.profileReference, {
            serviceCode,
            scheduleId,
            start,
          });
          return c.json(appointment, 201);
        } catch (err) {
          // The found window was booked in the meantime — the client re-picks calmly.
          if (err instanceof SlotTakenError) {
            return fail(c, "slot_taken", 409);
          }
          if (
            err instanceof UnknownServiceError ||
            err instanceof UnknownScheduleError ||
            err instanceof InvalidSlotError
          ) {
            return fail(c, "invalid_request", 400);
          }
          throw err;
        }
      });
    }

    // Staff (S5). Sessions gate every route, and every call runs AS the signed-in staff
    // member's own Medplum principal — their org-parameterized AccessPolicy (A3) is the
    // enforcement line and AuditEvents attribute to them, by construction. Encounter
    // writes belong to the check-in Bot (A7), never these routes.
    const staff = deps.staff;
    if (staff) {
      /** Session user with a staff (Practitioner) principal, else a typed refusal. */
      const staffUser = async (c: Context<Env>) => {
        const user = await sessionUser(c);
        if (!user) {
          return { fail: fail(c, "unauthorized", 401 as const) };
        }
        if (!user.profileReference.startsWith("Practitioner/")) {
          // A signed-in non-staff principal (e.g. a patient session) is a 403, not 404:
          // the route exists, the principal isn't allowed on it.
          return { fail: fail(c, "forbidden", 403 as const) };
        }
        return { user };
      };

      /** Shared staff error mapping: auth conditions and conflicts, never 500s. */
      const staffFailure = (c: Context<Env>, err: unknown) => {
        if (err instanceof SessionExpiredError) {
          return fail(c, "unauthorized", 401);
        }
        if (err instanceof ForbiddenError) {
          return fail(c, "forbidden", 403);
        }
        if (err instanceof UnknownAppointmentError) {
          return fail(c, "not_found", 404);
        }
        // Both mean "the appointment moved under you" — refetch and re-decide. A stale
        // day sheet (InvalidTransition) and a lost test-and-set race (StatusConflict)
        // have the same client recovery.
        if (err instanceof InvalidTransitionError || err instanceof StatusConflictError) {
          return fail(c, "conflict", 409);
        }
        throw err;
      };

      app.get("/staff/me", async (c) => {
        const user = await sessionUser(c);
        if (!user) {
          return fail(c, "unauthorized", 401);
        }
        try {
          const profile = await staff.getStaffProfile(user);
          // Not-a-staff-principal reads as "no staff profile" (mirrors /patients/me).
          return profile ? c.json(profile) : fail(c, "not_found", 404);
        } catch (err) {
          return staffFailure(c, err);
        }
      });

      // The schedule range: `date` (default today) + `days` (1 = day view, 7 = week).
      // Calendar navigation state, not PHI — the only query params this surface carries.
      app.get("/staff/schedule", async (c) => {
        const gate = await staffUser(c);
        if (!gate.user) {
          return gate.fail;
        }
        const date = c.req.query("date");
        if (date !== undefined && !isValidDateString(date)) {
          return fail(c, "invalid_request", 400);
        }
        const daysParam = c.req.query("days");
        if (daysParam !== undefined && daysParam !== "1" && daysParam !== "7") {
          return fail(c, "invalid_request", 400);
        }
        try {
          return c.json(
            await staff.getDaySheet(gate.user, date, daysParam ? Number(daysParam) : 1),
          );
        } catch (err) {
          return staffFailure(c, err);
        }
      });

      app.post("/staff/appointments/:id/status", async (c) => {
        const gate = await staffUser(c);
        if (!gate.user) {
          return gate.fail;
        }
        // ?? {} — a literal `null` body parses successfully, so the catch can't cover it.
        const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { status?: unknown };
        const status = body.status;
        if (
          typeof status !== "string" ||
          !(APPOINTMENT_STATUSES as readonly string[]).includes(status)
        ) {
          return fail(c, "invalid_request", 400);
        }
        try {
          return c.json(
            await staff.setAppointmentStatus(
              gate.user,
              c.req.param("id"),
              status as AppointmentStatus,
            ),
          );
        } catch (err) {
          return staffFailure(c, err);
        }
      });
    }
  }

  // NOTE: the former dev-only unauthenticated GET /patients/:id was removed with the
  // portal-login slice (docs/AUTH.md: replace, not extend). Patient reads happen only
  // through the session-scoped /patients/me above, as the end user's own principal.

  app.get("/health/medplum", async (c) => {
    try {
      const connected = await deps.checkMedplum();
      return connected ? c.json({ connected: true }) : c.json({ connected: false }, 503);
    } catch {
      return c.json({ connected: false }, 503);
    }
  });

  return app;
}
