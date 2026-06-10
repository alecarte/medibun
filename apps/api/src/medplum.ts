import { authenticatedMedplumClient, readConfigFromEnv } from "@medibun/medplum-backend";

/**
 * True when Medplum is reachable and the client-credentials login succeeds.
 *
 * Dev-only as wired: performs a fresh login per call and /health/medplum is
 * unauthenticated. Before any deployment this must be cached and the endpoint
 * gated/rate-limited (security-reviewer finding, 2026-06-10).
 */
export async function checkMedplumConnection(): Promise<boolean> {
  await authenticatedMedplumClient(readConfigFromEnv());
  return true;
}
