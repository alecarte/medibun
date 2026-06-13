import { serve } from "@hono/node-server";
import {
  authenticatedMedplumClient,
  createMedplumClient,
  directUserLogin,
  readConfigFromEnv,
  readPatientById,
  refreshUserTokens,
  revokeLoginById,
} from "@medibun/medplum-backend";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { createApp, type AppDeps, type AuthDeps } from "./app.js";
import { createTokenCipher } from "./auth/crypto.js";
import { createSessionStore } from "./auth/sessions.js";
import { readApiConfigFromEnv } from "./config.js";
import { checkMedplumConnection } from "./medplum.js";
import { toPatientProfile } from "./patients.js";

const config = readApiConfigFromEnv();

const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60_000;

/** Real auth wiring per docs/AUTH.md. Requires the experience DB + encryption key. */
function buildAuthDeps(): AuthDeps | undefined {
  const dbUrl = process.env.EXPERIENCE_DATABASE_URL;
  const key = process.env.SESSION_ENCRYPTION_KEY;
  const projectId = process.env.MEDPLUM_PROJECT_ID;
  if (!dbUrl || !key || !projectId) {
    console.log(
      JSON.stringify({
        msg: "auth disabled: EXPERIENCE_DATABASE_URL / SESSION_ENCRYPTION_KEY / MEDPLUM_PROJECT_ID unset",
      }),
    );
    return undefined;
  }
  const medplumConfig = readConfigFromEnv();
  const pool = new pg.Pool({ connectionString: dbUrl });
  const db = drizzle(pool);
  const store = createSessionStore(db, createTokenCipher(key), {
    refresh: (refreshToken) => refreshUserTokens(medplumConfig, refreshToken),
  });

  return {
    async login(email, password) {
      const tokens = await directUserLogin(medplumConfig, projectId, email, password);
      const sessionId = await store.create(tokens);
      return { sessionId };
    },
    async logout(sessionId) {
      // Local kill first and authoritatively: the session row is revoked and its tokens
      // cleared, so the client's session id is immediately dead regardless of what follows.
      const revoked = await store.revoke(sessionId);
      if (!revoked) {
        return;
      }
      // Best-effort upstream revocation of the Medplum Login (decided 2026-06-13). The
      // service ClientApplication is not yet granted AccessPolicy on the Login resource
      // (403), so this can fail — we log the id and move on rather than 500 the logout.
      // Residual risk is bounded: the access token is cleared from our store and expires
      // within the hour, and the refresh token is gone locally.
      // TODO(approval-gated): grant the service client Login read/write so this is
      // guaranteed, then make it authoritative again (docs/AUTH.md).
      try {
        const client = await authenticatedMedplumClient(medplumConfig);
        await revokeLoginById(client, revoked.loginId);
      } catch {
        console.log(
          JSON.stringify({
            msg: "upstream Login revoke failed (best-effort)",
            loginId: revoked.loginId,
          }),
        );
      }
    },
    getUser: (sessionId) => store.getUser(sessionId),
    async getMyProfile(user) {
      const [resourceType, id] = user.profileReference.split("/");
      if (resourceType !== "Patient" || !id) {
        return undefined; // staff /me comes later; patients only at v1
      }
      // Reads AS the end user: their token, their compartment, their AuditEvent attribution.
      const client = createMedplumClient(medplumConfig);
      client.setAccessToken(user.accessToken);
      const patient = await readPatientById(client, id);
      return patient && toPatientProfile(patient);
    },
    recordAndCheckRateLimit: (ip) => store.recordAndCheck(ip, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS),
    // Secure by default; explicit opt-out for local-http dev only.
    cookieSecure: process.env.API_COOKIE_INSECURE_DEV === "1" ? false : true,
    allowedOrigins: (process.env.API_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
    // Trust a proxy-set header only on explicit opt-in (Vercel overwrites x-real-ip).
    // Default: ignore client-controlled headers; all direct traffic shares one bucket.
    clientIp:
      process.env.API_TRUST_PROXY === "1"
        ? (req) => req.header("x-real-ip") ?? "direct"
        : undefined,
  };
}

/**
 * Dev-only, synthetic data only: unauthenticated patient reads exist solely behind
 * API_DEV_UNAUTHENTICATED=1 until the portal login UI lands (next auth PR), then this
 * guard is REMOVED per docs/AUTH.md. Fresh login per call — dev-only caveat as in medplum.ts.
 */
const getPatientProfile: AppDeps["getPatientProfile"] = config.devUnauthenticatedRoutes
  ? async (id) => {
      const client = await authenticatedMedplumClient(readConfigFromEnv());
      const patient = await readPatientById(client, id);
      return patient && toPatientProfile(patient);
    }
  : undefined;

const app = createApp({
  log: (entry) => console.log(JSON.stringify(entry)),
  checkMedplum: checkMedplumConnection,
  auth: buildAuthDeps(),
  getPatientProfile,
});

if (config.devUnauthenticatedRoutes) {
  console.log(JSON.stringify({ msg: "DEV MODE: unauthenticated routes mounted" }));
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(JSON.stringify({ msg: "api listening", port: info.port }));
});
