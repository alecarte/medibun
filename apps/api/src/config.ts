export type ApiConfig = {
  readonly port: number;
};

/** Read the API's own config from the environment. Medplum env is read by @medibun/medplum-backend. */
export function readApiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  if (env.PORT === undefined) {
    return { port: 3001 };
  }
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("Invalid PORT: must be a positive integer");
  }
  return { port };
}
