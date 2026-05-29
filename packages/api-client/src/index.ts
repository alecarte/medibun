/**
 * @medibun/api-client — the typed client for OUR backend (the BFF).
 *
 * ANTI-CORRUPTION BOUNDARY (binding, see PROJECT_BRIEF.md §2 + CLAUDE.md):
 * The product apps (patient-mobile, portal, staff) call THIS client only. They never
 * import a Medplum SDK, hold a Medplum session, or talk to Medplum/any EMR directly.
 * Our backend is the sole holder of the Medplum SDK and translates domain operations
 * to/from FHIR server-side. This client speaks our DOMAIN shapes, not FHIR resources.
 *
 * Step-1 placeholder: real endpoints arrive once the backend exists.
 */

export type ApiClientConfig = {
  /** Base URL of our backend (the BFF). Never a Medplum/EMR URL. */
  readonly baseUrl: string;
};

export type ApiClient = {
  readonly baseUrl: string;
  // TODO: typed domain methods (e.g. getPatientProfile, listMemberships) added with the backend.
};

export function createApiClient(config: ApiClientConfig): ApiClient {
  return { baseUrl: config.baseUrl };
}
