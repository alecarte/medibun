import type { PatientProfile } from "@medibun/api-client";
import {
  InvalidCredentialsError,
  MfaRequiredError,
  MultipleMembershipsError,
  SessionExpiredError,
} from "@medibun/medplum-backend";
import { describe, expect, it } from "vitest";

import { createApp, type AuthDeps, type LogEntry } from "./app.js";

/** Build an app with a captured log sink and a stubbed Medplum check. */
function makeApp(
  opts: {
    checkMedplum?: () => Promise<boolean>;
    auth?: Partial<AuthDeps>;
  } = {},
) {
  const logs: LogEntry[] = [];
  const auth: AuthDeps | undefined = opts.auth
    ? {
        login: () => Promise.resolve({ sessionId: "11111111-1111-4111-8111-111111111111" }),
        logout: () => Promise.resolve(),
        getUser: () => Promise.resolve(null),
        getMyProfile: () => Promise.resolve(undefined),
        recordAndCheckRateLimit: () => Promise.resolve(false),
        ...opts.auth,
      }
    : undefined;
  const app = createApp({
    log: (entry) => logs.push(entry),
    checkMedplum: opts.checkMedplum ?? (() => Promise.resolve(true)),
    auth,
  });
  return { app, logs };
}

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const { app } = makeApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("attaches a generated x-request-id response header", async () => {
    const { app } = makeApp();
    const res = await app.request("/health");
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("echoes an incoming x-request-id", async () => {
    const { app } = makeApp();
    const res = await app.request("/health", {
      headers: { "x-request-id": "test-correlation-id" },
    });
    expect(res.headers.get("x-request-id")).toBe("test-correlation-id");
  });
});

describe("request logging (PHI-safe)", () => {
  it("logs method, path, status, duration, and request id", async () => {
    const { app, logs } = makeApp();
    const res = await app.request("/health");
    expect(logs).toHaveLength(1);
    const entry = logs[0]!;
    expect(entry.method).toBe("GET");
    expect(entry.path).toBe("/health");
    expect(entry.status).toBe(200);
    expect(typeof entry.durationMs).toBe("number");
    expect(entry.requestId).toBe(res.headers.get("x-request-id"));
  });

  it("never logs the query string (query params may carry PHI)", async () => {
    const { app, logs } = makeApp();
    await app.request("/health?mrn=SYNTH-LEAK-CANARY&name=CANARY-NAME");
    expect(logs).toHaveLength(1);
    const serialized = JSON.stringify(logs[0]);
    expect(serialized).not.toContain("mrn");
    expect(serialized).not.toContain("SYNTH-LEAK-CANARY");
    expect(serialized).not.toContain("CANARY-NAME");
    expect(logs[0]!.path).toBe("/health");
  });
});

describe("error handling (PHI-safe)", () => {
  it("returns 404 with a generic body for unknown routes", async () => {
    const { app } = makeApp();
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("not_found");
    expect(body.requestId).toBe(res.headers.get("x-request-id"));
  });

  it("returns a generic 500 body that never leaks the error message", async () => {
    const { app } = makeApp();
    // Simulates a handler bug where a thrown error interpolates sensitive data.
    app.get("/boom", () => {
      throw new Error("SENSITIVE-PATIENT-VALUE");
    });
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("SENSITIVE-PATIENT-VALUE");
    const body = JSON.parse(text) as { error: string; requestId: string };
    expect(body.error).toBe("internal_error");
    expect(body.requestId).toBe(res.headers.get("x-request-id"));
  });
});

describe("GET /patients/:id (removed with the portal-login slice — regression guard)", () => {
  it("is never mounted: unauthenticated patient reads are gone for good", async () => {
    const { app } = makeApp();
    const res = await app.request("/patients/synth-1");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });
});

describe("auth routes", () => {
  const user = { profileReference: "Patient/p-1", accessToken: "at-1" };
  const profile: PatientProfile = { id: "p-1", name: "Synth Example" };

  it("are not mounted when auth deps are absent", async () => {
    const { app } = makeApp();
    expect((await app.request("/auth/login", { method: "POST" })).status).toBe(404);
    expect((await app.request("/patients/me")).status).toBe(404);
  });

  it("login issues a Secure HttpOnly session cookie and token by default", async () => {
    const { app } = makeApp({ auth: {} });
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "synth@example.test", password: "pw" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionToken: "11111111-1111-4111-8111-111111111111" });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("medibun_session=11111111-1111-4111-8111-111111111111");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
  });

  it("omits Secure only on explicit dev opt-out", async () => {
    const { app } = makeApp({ auth: { cookieSecure: false } });
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "synth@example.test", password: "pw" }),
    });
    expect(res.headers.get("set-cookie") ?? "").not.toContain("Secure");
  });

  it("rejects browser origins that are not allowlisted (CSRF defense)", async () => {
    const { app } = makeApp({ auth: { allowedOrigins: ["https://portal.example.test"] } });
    const evil = await app.request("/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: "https://evil.example.test",
      },
      body: JSON.stringify({ email: "synth@example.test", password: "pw" }),
    });
    expect(evil.status).toBe(403);
    const allowed = await app.request("/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: "https://portal.example.test",
      },
      body: JSON.stringify({ email: "synth@example.test", password: "pw" }),
    });
    expect(allowed.status).toBe(200);
  });

  it("ignores a spoofed x-forwarded-for unless a trusted clientIp resolver is wired", async () => {
    const buckets: string[] = [];
    const { app } = makeApp({
      auth: {
        recordAndCheckRateLimit: (ip) => {
          buckets.push(ip);
          return Promise.resolve(false);
        },
      },
    });
    await app.request("/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "6.6.6.6",
      },
      body: JSON.stringify({ email: "synth@example.test", password: "pw" }),
    });
    expect(buckets).toEqual(["direct"]);
  });

  it("uses the wired clientIp resolver for rate-limit buckets", async () => {
    const buckets: string[] = [];
    const { app } = makeApp({
      auth: {
        clientIp: (req) => req.header("x-real-ip") ?? "direct",
        recordAndCheckRateLimit: (ip) => {
          buckets.push(ip);
          return Promise.resolve(false);
        },
      },
    });
    await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "10.1.1.1" },
      body: JSON.stringify({ email: "synth@example.test", password: "pw" }),
    });
    expect(buckets).toEqual(["10.1.1.1"]);
  });

  it("login rejects invalid credentials with a generic 401 that never echoes the email", async () => {
    const { app } = makeApp({
      auth: { login: () => Promise.reject(new InvalidCredentialsError()) },
    });
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "synth@example.test", password: "wrong" }),
    });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).toContain("invalid_credentials");
    expect(text).not.toContain("synth@example.test");
  });

  it("login is rate-limited before credentials are tried", async () => {
    let loginCalls = 0;
    const { app } = makeApp({
      auth: {
        recordAndCheckRateLimit: () => Promise.resolve(true),
        login: () => {
          loginCalls += 1;
          return Promise.resolve({ sessionId: "x" });
        },
      },
    });
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "synth@example.test", password: "pw" }),
    });
    expect(res.status).toBe(429);
    expect(loginCalls).toBe(0);
  });

  it("maps an MFA-required login to a clean 501, not a 500", async () => {
    const { app } = makeApp({ auth: { login: () => Promise.reject(new MfaRequiredError()) } });
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "staff@example.test", password: "pw" }),
    });
    expect(res.status).toBe(501);
    expect((await res.json()).error).toBe("mfa_not_supported");
  });

  it("maps an unresolved-membership login to a clean 501", async () => {
    const { app } = makeApp({
      auth: { login: () => Promise.reject(new MultipleMembershipsError()) },
    });
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "multi@example.test", password: "pw" }),
    });
    expect(res.status).toBe(501);
    expect((await res.json()).error).toBe("membership_selection_not_supported");
  });

  it("login rejects a body without credentials", async () => {
    const { app } = makeApp({ auth: {} });
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("GET /patients/me requires a session", async () => {
    const { app } = makeApp({ auth: {} });
    expect((await app.request("/patients/me")).status).toBe(401);
  });

  it("GET /patients/me resolves the session user via bearer header", async () => {
    const { app } = makeApp({
      auth: {
        getUser: (id) =>
          Promise.resolve(id === "22222222-2222-4222-8222-222222222222" ? user : null),
        getMyProfile: (u) =>
          Promise.resolve(u.profileReference === "Patient/p-1" ? profile : undefined),
      },
    });
    const res = await app.request("/patients/me", {
      headers: { Authorization: "Bearer 22222222-2222-4222-8222-222222222222" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(profile);
  });

  it("falls back to the cookie when the Bearer header is present but empty", async () => {
    const { app } = makeApp({
      auth: {
        getUser: (id) =>
          Promise.resolve(id === "22222222-2222-4222-8222-222222222222" ? user : null),
        getMyProfile: () => Promise.resolve(profile),
      },
    });
    // An empty "Bearer " must not shadow a valid cookie.
    const res = await app.request("/patients/me", {
      headers: {
        Authorization: "Bearer ",
        Cookie: "medibun_session=22222222-2222-4222-8222-222222222222",
      },
    });
    expect(res.status).toBe(200);
  });

  it("GET /patients/me resolves the session user via cookie", async () => {
    const { app } = makeApp({
      auth: {
        getUser: (id) =>
          Promise.resolve(id === "22222222-2222-4222-8222-222222222222" ? user : null),
        getMyProfile: () => Promise.resolve(profile),
      },
    });
    const res = await app.request("/patients/me", {
      headers: { Cookie: "medibun_session=22222222-2222-4222-8222-222222222222" },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 (not 500) when the AS-user read is rejected upstream (token-expiry race)", async () => {
    const { app } = makeApp({
      auth: {
        getUser: () => Promise.resolve(user),
        getMyProfile: () => Promise.reject(new SessionExpiredError()),
      },
    });
    const res = await app.request("/patients/me", {
      headers: { Authorization: "Bearer 22222222-2222-4222-8222-222222222222" },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
  });

  it("logout still succeeds (200, cookie cleared) when upstream revocation fails", async () => {
    const { app } = makeApp({
      auth: { logout: () => Promise.reject(new Error("Forbidden")) },
    });
    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: { Cookie: "medibun_session=44444444-4444-4444-8444-444444444444" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toContain("medibun_session=;");
  });

  it("logout revokes the session and clears the cookie", async () => {
    const revoked: string[] = [];
    const { app } = makeApp({
      auth: {
        logout: (id) => {
          revoked.push(id);
          return Promise.resolve();
        },
      },
    });
    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: { Cookie: "medibun_session=33333333-3333-4333-8333-333333333333" },
    });
    expect(res.status).toBe(200);
    expect(revoked).toEqual(["33333333-3333-4333-8333-333333333333"]);
    expect(res.headers.get("set-cookie") ?? "").toContain("medibun_session=;");
  });
});

describe("GET /health/medplum", () => {
  it("reports connected when the Medplum check succeeds", async () => {
    const { app } = makeApp({ checkMedplum: () => Promise.resolve(true) });
    const res = await app.request("/health/medplum");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true });
  });

  it("reports 503 not-connected when the check throws, without leaking the reason", async () => {
    const { app } = makeApp({
      checkMedplum: () => Promise.reject(new Error("credentials for patient X invalid")),
    });
    const res = await app.request("/health/medplum");
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain("credentials");
    expect(JSON.parse(text)).toEqual({ connected: false });
  });
});
