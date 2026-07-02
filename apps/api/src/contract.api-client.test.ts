import { createApiClient, LoginError } from "@medibun/api-client";
import { describe, expect, it } from "vitest";

import { createApp, type AuthDeps } from "./app.js";

/**
 * Cross-package contract test (testing.md): the real @medibun/api-client speaks to the
 * real BFF app in-process, so a drift in route shape or DTO breaks here, not in an app.
 */
const user = { profileReference: "Patient/p-1", accessToken: "at-1" };

function makeApp(overrides: Partial<AuthDeps> = {}) {
  const auth: AuthDeps = {
    login: () => Promise.resolve({ sessionId: "session-1" }),
    logout: () => Promise.resolve(),
    getUser: (sessionId) => Promise.resolve(sessionId === "session-1" ? user : null),
    getMyProfile: () =>
      Promise.resolve({ id: "p-1", name: "Synth Example", birthDate: "1990-01-01" }),
    recordAndCheckRateLimit: () => Promise.resolve(false),
    cookieSecure: false,
    ...overrides,
  };
  return createApp({
    log: () => undefined,
    checkMedplum: () => Promise.resolve(true),
    auth,
  });
}

function makeClient(overrides: Partial<AuthDeps> = {}) {
  const app = makeApp(overrides);
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    app.request(input, init)) as typeof fetch;
  return createApiClient({ baseUrl: "http://bff.test", fetch: fetchImpl });
}

describe("api-client ⇄ BFF contract", () => {
  it("logs in and returns the opaque session token", async () => {
    const client = makeClient();
    await expect(client.login("synthia@example.test", "pw")).resolves.toEqual({
      sessionToken: "session-1",
    });
  });

  it("maps a BFF login failure to a typed LoginError", async () => {
    const client = makeClient({ login: () => Promise.reject(new Error("upstream down")) });
    const err = await client.login("synthia@example.test", "bad").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginError);
  });

  it("round-trips the signed-in profile DTO via bearer auth", async () => {
    const client = makeClient();
    await expect(client.getMyProfile({ sessionToken: "session-1" })).resolves.toEqual({
      id: "p-1",
      name: "Synth Example",
      birthDate: "1990-01-01",
    });
  });

  it("round-trips the signed-in profile DTO via the session cookie (web path)", async () => {
    const client = makeClient();
    await expect(client.getMyProfile({ cookie: "medibun_session=session-1" })).resolves.toEqual({
      id: "p-1",
      name: "Synth Example",
      birthDate: "1990-01-01",
    });
  });

  it("resolves undefined for an unknown session (BFF 401)", async () => {
    const client = makeClient();
    await expect(client.getMyProfile({ sessionToken: "nope" })).resolves.toBeUndefined();
  });

  it("logs out without error", async () => {
    const client = makeClient();
    await expect(client.logout({ sessionToken: "session-1" })).resolves.toBeUndefined();
  });

  it("the dev-only unauthenticated patient read is gone for good", async () => {
    const app = makeApp();
    const res = await app.request("/patients/some-id");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });
});
