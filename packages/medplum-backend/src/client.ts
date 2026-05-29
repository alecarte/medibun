import { MedplumClient } from "@medplum/core";

/**
 * @medibun/medplum-backend — the server-side Medplum integration.
 *
 * ANTI-CORRUPTION BOUNDARY (binding, see CLAUDE.md + docs/ARCHITECTURE.md):
 * This is the ONLY place a Medplum SDK client is constructed. The product apps
 * (patient-mobile, portal, staff) NEVER import this package or hold a Medplum session — they go
 * through our BFF via @medibun/api-client. This package is the first slice of that backend.
 *
 * Dev: points at the local self-hosted Medplum (infra/medplum). Prod: Medplum Cloud (later).
 * Credentials come from the environment — never hardcoded, never committed.
 */

export type MedplumBackendConfig = {
  /** Medplum server base URL (trailing slash). Dev: http://localhost:8103/ */
  readonly baseUrl: string;
  /** ClientApplication credentials (OAuth2 client-credentials flow). */
  readonly clientId: string;
  readonly clientSecret: string;
};

/** Read config from the environment. Throws if anything required is missing. */
export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MedplumBackendConfig {
  const baseUrl = env.MEDPLUM_BASE_URL;
  const clientId = env.MEDPLUM_CLIENT_ID;
  const clientSecret = env.MEDPLUM_CLIENT_SECRET;
  const missing = [
    ["MEDPLUM_BASE_URL", baseUrl],
    ["MEDPLUM_CLIENT_ID", clientId],
    ["MEDPLUM_CLIENT_SECRET", clientSecret],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`Missing Medplum env vars: ${missing.join(", ")} (see infra/medplum/.env.example)`);
  }
  return { baseUrl: baseUrl!, clientId: clientId!, clientSecret: clientSecret! };
}

/** Construct a Medplum client. Does not authenticate — call `authenticate()` for that. */
export function createMedplumClient(config: MedplumBackendConfig): MedplumClient {
  return new MedplumClient({ baseUrl: config.baseUrl });
}

/** Construct + authenticate via OAuth2 client credentials. */
export async function authenticatedMedplumClient(
  config: MedplumBackendConfig,
): Promise<MedplumClient> {
  const medplum = createMedplumClient(config);
  await medplum.startClientLogin(config.clientId, config.clientSecret);
  return medplum;
}
