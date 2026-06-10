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

export type ApiClient = {
  readonly baseUrl: string;
  /** Resolves undefined when the backend reports the patient does not exist. */
  readonly getPatientProfile: (id: string) => Promise<PatientProfile | undefined>;
};

export function createApiClient(config: ApiClientConfig): ApiClient {
  const fetchImpl = config.fetch ?? fetch;
  const baseUrl = config.baseUrl.replace(/\/$/, "");

  return {
    baseUrl: config.baseUrl,
    async getPatientProfile(id) {
      const res = await fetchImpl(`${baseUrl}/patients/${encodeURIComponent(id)}`);
      if (res.status === 404) {
        return undefined;
      }
      if (!res.ok) {
        // Generic by design: response bodies never make it into thrown messages.
        throw new Error(`api-client: GET /patients failed with status ${res.status}`);
      }
      return (await res.json()) as PatientProfile;
    },
  };
}
