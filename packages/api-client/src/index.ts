import type { CategoryColor } from "@medibun/design-tokens";

/**
 * @medibun/api-client — the typed client for OUR backend (the BFF).
 *
 * ANTI-CORRUPTION BOUNDARY (binding, see PROJECT_BRIEF.md §2 + CLAUDE.md):
 * The product apps (patient-mobile, portal, staff) call THIS client only. They never
 * import a Medplum SDK, hold a Medplum session, or talk to Medplum/any EMR directly.
 * Our backend is the sole holder of the Medplum SDK and translates domain operations
 * to/from FHIR server-side. This client speaks our DOMAIN shapes, not FHIR resources.
 */

/** Domain DTO for a patient profile. Deliberately minimal (data minimization). */
export type PatientProfile = {
  readonly id: string;
  /** Display name, already formatted by the backend. */
  readonly name: string;
  /** ISO date (YYYY-MM-DD), when known. */
  readonly birthDate?: string;
};

/** Categorical color token key — the design-tokens union itself (type-only import,
 *  no runtime dependency), so a palette change breaks typecheck instead of drifting. */
export type ServiceColor = CategoryColor;

/** A bookable service from the practice's menu (experience data — no PHI). */
export type ServiceSummary = {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly durationMinutes: number;
  readonly priceCents: number;
  readonly categoryColor: ServiceColor;
};

/** One offered appointment window. ISO instants. */
export type AvailabilitySlot = {
  readonly start: string;
  readonly end: string;
};

/** A practitioner's open times for one service. */
export type PractitionerAvailability = {
  readonly scheduleId: string;
  readonly practitionerId: string;
  /** Display name, already formatted by the backend. */
  readonly practitionerName: string;
  readonly slots: readonly AvailabilitySlot[];
};

export type ServiceAvailability = {
  readonly serviceCode: string;
  /** IANA practice timezone — format slot times and bucket days in it. */
  readonly timezone: string;
  /** The exact window the slots were fetched for (ISO instant + day count) — the UI
   *  renders THIS window, never a clock of its own, so no slot can fall outside it. */
  readonly windowStart: string;
  readonly windowDays: number;
  readonly practitioners: readonly PractitionerAvailability[];
};

/** What the client sends to book: a slot exactly as returned by getAvailability. */
export type BookingRequest = {
  readonly serviceCode: string;
  readonly scheduleId: string;
  /** ISO instant — the `start` of a slot from getAvailability. */
  readonly start: string;
};

/** The patient's own confirmed booking (their data, returned to them). */
export type BookedAppointment = {
  readonly id: string;
  readonly serviceCode: string;
  readonly serviceName: string;
  readonly practitionerName: string;
  readonly start: string;
  readonly end: string;
};

export type ApiClientConfig = {
  /** Base URL of our backend (the BFF). Never a Medplum/EMR URL. */
  readonly baseUrl: string;
  /** Injectable fetch (tests, custom runtimes). Defaults to global fetch. */
  readonly fetch?: typeof fetch;
};

/**
 * How a call proves its session. Web (portal/staff) forwards the HttpOnly cookie —
 * browsers attach it automatically on same-origin calls, and RSC server-side calls pass
 * it explicitly; mobile sends the opaque session token as a bearer header (AUTH.md).
 */
export type SessionAuth = {
  readonly cookie?: string;
  readonly sessionToken?: string;
};

/** The BFF's session cookie name — the one shared constant between the BFF (which sets
 *  it) and web apps (which forward it server-side). Change it here, nowhere else. */
export const SESSION_COOKIE_NAME = "medibun_session";

/** Backend login error codes (the BFF's stable, PHI-free error contract).
 *  Single source of truth: the type derives from this array. */
const LOGIN_CODES = [
  "invalid_credentials",
  "rate_limited",
  "mfa_not_supported",
  "membership_selection_not_supported",
] as const;

export type LoginErrorCode = (typeof LOGIN_CODES)[number] | "unknown";

/** Login failure with the backend's error code. Never carries credentials or PHI. */
export class LoginError extends Error {
  readonly code: LoginErrorCode;
  constructor(code: LoginErrorCode, status: number) {
    super(`api-client: login failed (${code}, status ${status})`);
    this.name = "LoginError";
    this.code = code;
  }
}

/** Booking error codes (the BFF's stable, PHI-free error contract). */
const BOOKING_CODES = [
  "slot_taken",
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
] as const;

export type BookingErrorCode = (typeof BOOKING_CODES)[number] | "unknown";

/** Booking failure with the backend's error code. Never carries PHI. */
export class BookingError extends Error {
  readonly code: BookingErrorCode;
  constructor(code: BookingErrorCode, status: number) {
    super(`api-client: booking request failed (${code}, status ${status})`);
    this.name = "BookingError";
    this.code = code;
  }
}

export type ApiClient = {
  readonly baseUrl: string;
  /** Brokered login. Resolves the opaque session token (web also gets an HttpOnly cookie). */
  readonly login: (email: string, password: string) => Promise<{ sessionToken: string }>;
  /** Ends the session. Resolves even when upstream revocation is best-effort (BFF contract). */
  readonly logout: (auth?: SessionAuth) => Promise<void>;
  /** The signed-in patient's own profile. Resolves undefined when not signed in (401)
   *  or when the session is valid but no patient profile resolves (404) — both are
   *  benign signed-out-equivalent states for a UI, never crashes. */
  readonly getMyProfile: (auth?: SessionAuth) => Promise<PatientProfile | undefined>;
  /** The practice's bookable service menu. Requires a session. Throws BookingError. */
  readonly listServices: (auth?: SessionAuth) => Promise<ServiceSummary[]>;
  /** Open times per practitioner for one service over the booking window (next 7 days,
   *  BFF-owned). Throws BookingError — "not_found" for an unknown service code. */
  readonly getAvailability: (
    serviceCode: string,
    auth?: SessionAuth,
  ) => Promise<ServiceAvailability>;
  /** Books a found slot for the signed-in patient. Throws BookingError — "slot_taken"
   *  when the window was booked between availability and confirm (safe to re-pick). */
  readonly book: (request: BookingRequest, auth?: SessionAuth) => Promise<BookedAppointment>;
};

/** The BFF error envelope is `{error: code, requestId}`; parse the code against an
 *  allowlist, degrading anything unrecognized (or unparseable) to "unknown". The one
 *  place the envelope's wire shape is decoded — login and booking both go through it. */
async function errorCodeFrom<Code extends string>(
  res: Response,
  codes: readonly Code[],
): Promise<Code | "unknown"> {
  return res
    .json()
    .then((body: unknown) => {
      const error = (body as { error?: string } | null)?.error ?? "";
      return (codes as readonly string[]).includes(error) ? (error as Code) : "unknown";
    })
    .catch(() => "unknown" as const);
}

/** Typed booking failure from the BFF's PHI-free error body. */
async function bookingFailure(res: Response): Promise<BookingError> {
  return new BookingError(await errorCodeFrom(res, BOOKING_CODES), res.status);
}

function authHeaders(auth?: SessionAuth): Record<string, string> {
  if (auth?.sessionToken) {
    return { authorization: `Bearer ${auth.sessionToken}` };
  }
  if (auth?.cookie) {
    return { cookie: auth.cookie };
  }
  return {};
}

export function createApiClient(config: ApiClientConfig): ApiClient {
  const fetchImpl = config.fetch ?? fetch;
  const baseUrl = config.baseUrl.replace(/\/$/, "");

  return {
    baseUrl: config.baseUrl,

    async login(email, password) {
      const res = await fetchImpl(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        // The BFF's error codes are PHI-free by contract; credentials never enter messages.
        throw new LoginError(await errorCodeFrom(res, LOGIN_CODES), res.status);
      }
      return (await res.json()) as { sessionToken: string };
    },

    async logout(auth) {
      const res = await fetchImpl(`${baseUrl}/auth/logout`, {
        method: "POST",
        headers: authHeaders(auth),
      });
      if (!res.ok) {
        throw new Error(`api-client: POST /auth/logout failed with status ${res.status}`);
      }
    },

    async listServices(auth) {
      const res = await fetchImpl(`${baseUrl}/services`, { headers: authHeaders(auth) });
      if (!res.ok) {
        throw await bookingFailure(res);
      }
      const body = (await res.json()) as { services: ServiceSummary[] };
      return body.services;
    },

    async getAvailability(serviceCode, auth) {
      const res = await fetchImpl(
        `${baseUrl}/services/${encodeURIComponent(serviceCode)}/availability`,
        { headers: authHeaders(auth) },
      );
      if (!res.ok) {
        throw await bookingFailure(res);
      }
      return (await res.json()) as ServiceAvailability;
    },

    async book(request, auth) {
      const res = await fetchImpl(`${baseUrl}/appointments`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(auth) },
        body: JSON.stringify(request),
      });
      if (!res.ok) {
        throw await bookingFailure(res);
      }
      return (await res.json()) as BookedAppointment;
    },

    async getMyProfile(auth) {
      const res = await fetchImpl(`${baseUrl}/patients/me`, { headers: authHeaders(auth) });
      // 401 = no/expired session; 404 = valid session but no resolvable patient profile
      // (the BFF's benign "no profile for this principal" response, e.g. a deleted
      // Patient or a future staff session). Both read as "no profile" to callers —
      // review finding 2026-07-02: throwing on the 404 crashed every portal RSC render.
      if (res.status === 401 || res.status === 404) {
        return undefined;
      }
      if (!res.ok) {
        // Generic by design: response bodies never make it into thrown messages.
        throw new Error(`api-client: GET /patients/me failed with status ${res.status}`);
      }
      return (await res.json()) as PatientProfile;
    },
  };
}
