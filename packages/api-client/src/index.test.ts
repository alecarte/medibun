import { describe, it, expect } from "vitest";
import { createApiClient, LoginError, type PatientProfile } from "./index.js";

/** Stub fetch returning a canned response; records the requests it received. */
function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetchImpl, calls };
}

const profile: PatientProfile = { id: "p1", name: "Synth Example", birthDate: "1990-01-01" };

describe("api-client", () => {
  it("creates a client pointed at our backend base URL", () => {
    const client = createApiClient({ baseUrl: "https://api.example.test" });
    expect(client.baseUrl).toBe("https://api.example.test");
  });

  describe("login", () => {
    it("POSTs credentials to /auth/login and returns the session token", async () => {
      const { fetchImpl, calls } = stubFetch(200, { sessionToken: "s-123" });
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      await expect(client.login("synthia@example.test", "pw")).resolves.toEqual({
        sessionToken: "s-123",
      });
      expect(calls[0]!.url).toBe("https://api.example.test/auth/login");
      expect(calls[0]!.init?.method).toBe("POST");
      expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
        email: "synthia@example.test",
        password: "pw",
      });
    });

    it("throws a typed LoginError carrying the backend error code on 401", async () => {
      const { fetchImpl } = stubFetch(401, { error: "invalid_credentials", requestId: "r" });
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      const err = await client.login("synthia@example.test", "bad").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LoginError);
      expect((err as LoginError).code).toBe("invalid_credentials");
    });

    it("maps rate limiting to its code", async () => {
      const { fetchImpl } = stubFetch(429, { error: "rate_limited", requestId: "r" });
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      const err = await client.login("a@b.test", "pw").catch((e: unknown) => e);
      expect((err as LoginError).code).toBe("rate_limited");
    });

    it("never includes the email or password in error messages", async () => {
      const { fetchImpl } = stubFetch(401, { error: "invalid_credentials", requestId: "r" });
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      const err = await client.login("secret@example.test", "hunter2").catch((e: unknown) => e);
      expect(String((err as Error).message)).not.toMatch(/secret@example\.test|hunter2/);
    });
  });

  describe("getMyProfile", () => {
    it("GETs /patients/me forwarding a cookie header (RSC server-side use)", async () => {
      const { fetchImpl, calls } = stubFetch(200, profile);
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      await expect(client.getMyProfile({ cookie: "medibun_session=abc" })).resolves.toEqual(
        profile,
      );
      expect(calls[0]!.url).toBe("https://api.example.test/patients/me");
      expect(new Headers(calls[0]!.init?.headers).get("cookie")).toBe("medibun_session=abc");
    });

    it("sends a bearer header when given a session token (mobile use)", async () => {
      const { fetchImpl, calls } = stubFetch(200, profile);
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      await client.getMyProfile({ sessionToken: "s-123" });
      expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer s-123");
    });

    it("resolves undefined on 401 (signed out / expired)", async () => {
      const { fetchImpl } = stubFetch(401, { error: "unauthenticated", requestId: "r" });
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      await expect(client.getMyProfile({ cookie: "medibun_session=x" })).resolves.toBeUndefined();
    });

    it("throws on other error statuses without including the response body", async () => {
      const { fetchImpl } = stubFetch(500, { error: "internal_error", requestId: "r" });
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      await expect(client.getMyProfile()).rejects.toThrow(/500/);
    });
  });

  describe("logout", () => {
    it("POSTs /auth/logout forwarding session auth and resolves on ok", async () => {
      const { fetchImpl, calls } = stubFetch(200, { ok: true });
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      await expect(client.logout({ cookie: "medibun_session=abc" })).resolves.toBeUndefined();
      expect(calls[0]!.url).toBe("https://api.example.test/auth/logout");
      expect(calls[0]!.init?.method).toBe("POST");
      expect(new Headers(calls[0]!.init?.headers).get("cookie")).toBe("medibun_session=abc");
    });

    it("throws generically on failure statuses", async () => {
      const { fetchImpl } = stubFetch(500, { error: "internal_error", requestId: "r" });
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      await expect(client.logout()).rejects.toThrow(/500/);
    });
  });
});
