import { SESSION_COOKIE_NAME } from "@medibun/api-client";
import type { PatientProfile } from "@medibun/api-client";
import {
  InvalidCredentialsError,
  MfaRequiredError,
  MultipleMembershipsError,
  SessionExpiredError,
} from "@medibun/medplum-backend";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";

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

export type AppDeps = {
  readonly log: (entry: LogEntry) => void;
  /** Resolves true when Medplum is reachable and credentials are valid. */
  readonly checkMedplum: () => Promise<boolean>;
  /** Auth routes mount only when provided (docs/AUTH.md). */
  readonly auth?: AuthDeps;
};

type Env = { Variables: { requestId: string } };

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
  | "unauthorized";

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
    // Origins must be allowlisted on mutating auth routes. No Origin (curl, mobile,
    // server-to-server) passes — the cookie isn't attached in those cases anyway.
    const allowedOrigins = new Set(auth.allowedOrigins ?? []);
    app.use("/auth/*", async (c, next) => {
      const origin = c.req.header("Origin");
      if (c.req.method !== "GET" && origin && !allowedOrigins.has(origin)) {
        return fail(c, "forbidden_origin", 403);
      }
      await next();
    });

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
      const body = (await c.req.json().catch(() => ({}))) as {
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

    app.get("/patients/me", async (c) => {
      const sessionId = resolveSessionId(c);
      const user = sessionId ? await auth.getUser(sessionId) : null;
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
