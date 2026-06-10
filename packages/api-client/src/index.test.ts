import { describe, it, expect } from "vitest";
import { createApiClient, type PatientProfile } from "./index.js";

/** Stub fetch returning a canned response; records the request it received. */
function stubFetch(status: number, body: unknown) {
  const calls: { url: string }[] = [];
  const fetchImpl: typeof fetch = (input) => {
    calls.push({ url: String(input) });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetchImpl, calls };
}

describe("api-client", () => {
  it("creates a client pointed at our backend base URL", () => {
    const client = createApiClient({ baseUrl: "https://api.example.test" });
    expect(client.baseUrl).toBe("https://api.example.test");
  });

  describe("getPatientProfile", () => {
    const profile: PatientProfile = { id: "p1", name: "Synth Example", birthDate: "1990-01-01" };

    it("GETs /patients/:id from the backend and returns the profile DTO", async () => {
      const { fetchImpl, calls } = stubFetch(200, profile);
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      await expect(client.getPatientProfile("p1")).resolves.toEqual(profile);
      expect(calls).toEqual([{ url: "https://api.example.test/patients/p1" }]);
    });

    it("URL-encodes the patient id", async () => {
      const { fetchImpl, calls } = stubFetch(200, profile);
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      await client.getPatientProfile("a/b");
      expect(calls[0]!.url).toBe("https://api.example.test/patients/a%2Fb");
    });

    it("returns undefined when the backend reports 404", async () => {
      const { fetchImpl } = stubFetch(404, { error: "not_found", requestId: "r" });
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      await expect(client.getPatientProfile("missing")).resolves.toBeUndefined();
    });

    it("throws on other error statuses without including the response body", async () => {
      const { fetchImpl } = stubFetch(500, { error: "internal_error", requestId: "r" });
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      await expect(client.getPatientProfile("p1")).rejects.toThrow(/500/);
    });
  });
});
