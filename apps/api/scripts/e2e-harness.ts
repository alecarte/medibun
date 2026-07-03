/**
 * SYNTHETIC E2E HARNESS — LOCAL DEV ONLY. Never deployed, never imported by src/.
 *
 * Runs the REAL BFF (app routes, session store, token crypto, medplum-backend login
 * flow) against an in-process fake of the four Medplum endpoints the BFF touches
 * (/auth/login, /oauth2/token, /auth/me, FHIR Patient read), with PGlite standing in
 * for Postgres. It exists because the cloud sandbox cannot pull the Medplum docker
 * images; on a normal dev machine use infra/medplum/setup-dev.sh (real Medplum) —
 * that path also live-verifies the AccessPolicy binding, which this harness cannot.
 *
 * Synthetic data only. No PHI. Run: pnpm --filter @medibun/api e2e:harness
 */
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { PGlite } from "@electric-sql/pglite";
import {
  createMedplumClient,
  directUserLogin,
  readPatientById,
  refreshUserTokens,
} from "@medibun/medplum-backend";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { Hono } from "hono";

import { createApp, type AuthDeps } from "../src/app.js";
import { createTokenCipher } from "../src/auth/crypto.js";
import { createSessionStore } from "../src/auth/sessions.js";
import * as schema from "../src/db/schema.js";
import { toPatientProfile } from "../src/patients.js";

const FAKE_MEDPLUM_PORT = 8199;
const BFF_PORT = Number(process.env.PORT ?? 3001);
const EMAIL = "synthia.login@example.test";
const PASSWORD = "synth-pw-12345";
const PATIENT = {
  resourceType: "Patient" as const,
  id: "pat-synthia",
  name: [{ given: ["Synthia"], family: "Loginsmith" }],
  birthDate: "1993-04-12",
};

// ---------- fake Medplum (the ONLY faked layer) ----------
const fake = new Hono();
let counter = 0;
const codes = new Map<string, string>();

fake.post("/auth/login", async (c) => {
  const body = (await c.req.json()) as { email?: string; password?: string };
  if (body.email !== EMAIL || body.password !== PASSWORD) {
    return c.json({ resourceType: "OperationOutcome" }, 401);
  }
  counter += 1;
  const code = `code-${counter}`;
  codes.set(code, `login-${counter}`);
  return c.json({ login: `login-${counter}`, code });
});

fake.post("/oauth2/token", async (c) => {
  const params = new URLSearchParams(await c.req.text());
  const grant = params.get("grant_type");
  const valid =
    (grant === "authorization_code" && codes.delete(params.get("code") ?? "")) ||
    (grant === "refresh_token" && (params.get("refresh_token") ?? "").startsWith("rt-"));
  if (!valid) {
    return c.json({ error: "invalid_grant" }, 400);
  }
  counter += 1;
  return c.json({
    access_token: `at-${counter}`,
    refresh_token: `rt-${counter}`,
    expires_in: 3600,
  });
});

fake.get("/auth/me", (c) => c.json({ profile: { resourceType: "Patient", id: PATIENT.id } }));

fake.get("/fhir/R4/Patient/:id", (c) =>
  c.req.param("id") === PATIENT.id
    ? c.json(PATIENT)
    : c.json({ resourceType: "OperationOutcome", issue: [] }, 404),
);

serve({ fetch: fake.fetch, port: FAKE_MEDPLUM_PORT, hostname: "127.0.0.1" }, () => {
  console.log(JSON.stringify({ msg: "fake medplum listening", port: FAKE_MEDPLUM_PORT }));
});

// ---------- the REAL BFF, wired exactly like src/index.ts (PGlite for pg) ----------
const medplumConfig = {
  baseUrl: `http://localhost:${FAKE_MEDPLUM_PORT}/`,
  clientId: "e2e-client",
  clientSecret: "e2e-secret",
};

const pglite = new PGlite();
const db = drizzle(pglite, { schema });
await migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });

const store = createSessionStore(db, createTokenCipher(randomBytes(32).toString("base64")), {
  refresh: (refreshToken) => refreshUserTokens(medplumConfig, refreshToken),
});

const auth: AuthDeps = {
  async login(email, password) {
    const tokens = await directUserLogin(medplumConfig, "e2e-project", email, password);
    const sessionId = await store.create(tokens);
    return { sessionId };
  },
  async logout(sessionId) {
    // Local-authoritative revoke only; the best-effort upstream Login revoke is
    // exercised by unit tests and the real setup-dev.sh path.
    await store.revoke(sessionId);
  },
  getUser: (sessionId) => store.getUser(sessionId),
  async getMyProfile(user) {
    const [resourceType, id] = user.profileReference.split("/");
    if (resourceType !== "Patient" || !id) {
      return undefined;
    }
    const client = createMedplumClient(medplumConfig);
    client.setAccessToken(user.accessToken);
    const patient = await readPatientById(client, id);
    return patient && toPatientProfile(patient);
  },
  recordAndCheckRateLimit: (ip) => store.recordAndCheck(ip, 10, 15 * 60_000),
  cookieSecure: false,
  allowedOrigins: ["http://localhost:3100"],
};

const app = createApp({
  log: (entry) => console.log(JSON.stringify(entry)),
  checkMedplum: () => Promise.resolve(true),
  auth,
});

serve({ fetch: app.fetch, port: BFF_PORT, hostname: "127.0.0.1" }, () => {
  console.log(JSON.stringify({ msg: "e2e harness BFF listening", port: BFF_PORT }));
});
