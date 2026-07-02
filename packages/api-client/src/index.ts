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

/** Backend login error codes (the BFF's stable, PHI-free error contract). */
export type LoginErrorCode =
  | "invalid_credentials"
  | "rate_limited"
  | "mfa_not_supported"
  | "membership_selection_not_supported"
  | "unknown";

/** Login failure with the backend's error code. Never carries credentials or PHI. */
export class LoginError extends Error {
  readonly code: LoginErrorCode;
  constructor(code: LoginErrorCode, status: number) {
    super(`api-client: login failed (${code}, status ${status})`);
    this.name = "LoginError";
    this.code = code;
  }
}

export type ApiClient = {
  readonly baseUrl: string;
  /** Brokered login. Resolves the opaque session token (web also gets an HttpOnly cookie). */
  readonly login: (email: string, password: string) => Promise<{ sessionToken: string }>;
  /** Ends the session. Resolves even when upstream revocation is best-effort (BFF contract). */
  readonly logout: (auth?: SessionAuth) => Promise<void>;
  /** The signed-in patient's own profile. Resolves undefined when not signed in (401). */
  readonly getMyProfile: (auth?: SessionAuth) => Promise<PatientProfile | undefined>;
};

const LOGIN_CODES: readonly LoginErrorCode[] = [
  "invalid_credentials",
  "rate_limited",
  "mfa_not_supported",
  "membership_selection_not_supported",
];

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
        const code: LoginErrorCode = await res
          .json()
          .then((body: unknown) => {
            const error = (body as { error?: string } | null)?.error;
            return LOGIN_CODES.includes(error as LoginErrorCode)
              ? (error as LoginErrorCode)
              : "unknown";
          })
          .catch(() => "unknown" as const);
        throw new LoginError(code, res.status);
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

    async getMyProfile(auth) {
      const res = await fetchImpl(`${baseUrl}/patients/me`, { headers: authHeaders(auth) });
      if (res.status === 401) {
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
