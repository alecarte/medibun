export type ApiConfig = {
  readonly port: number;
  /**
   * Mounts unauthenticated dev-only routes (e.g. /patients/:id) when exactly "1".
   * Never set in any deployed environment — these routes have no auth until the
   * approval-gated auth work lands. Local synthetic data only.
   */
  readonly devUnauthenticatedRoutes: boolean;
};

/** Read the API's own config from the environment. Medplum env is read by @medibun/medplum-backend. */
export function readApiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const devUnauthenticatedRoutes = env.API_DEV_UNAUTHENTICATED === "1";
  if (devUnauthenticatedRoutes && env.NODE_ENV === "production") {
    // Second factor behind the dev guard (security-reviewer, 2026-06-10): a copy-pasted
    // env var must not be able to expose an unauthenticated PHI route in production.
    throw new Error("API_DEV_UNAUTHENTICATED=1 is not allowed when NODE_ENV=production");
  }
  if (env.PORT === undefined) {
    return { port: 3001, devUnauthenticatedRoutes };
  }
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("Invalid PORT: must be a positive integer");
  }
  return { port, devUnauthenticatedRoutes };
}
