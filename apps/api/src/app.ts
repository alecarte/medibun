import { Hono } from "hono";

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

export type AppDeps = {
  readonly log: (entry: LogEntry) => void;
  /** Resolves true when Medplum is reachable and credentials are valid. */
  readonly checkMedplum: () => Promise<boolean>;
};

type Env = { Variables: { requestId: string } };

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();

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

  app.onError((_err, c) => c.json({ error: "internal_error", requestId: c.get("requestId") }, 500));

  app.notFound((c) => c.json({ error: "not_found", requestId: c.get("requestId") }, 404));

  app.get("/health", (c) => c.json({ status: "ok" }));

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
