import { createApiClient } from "@medibun/api-client";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";

/**
 * Cross-package contract test (testing.md): the real @medibun/api-client speaks to the
 * real BFF app in-process, so a drift in route shape or DTO breaks here, not in an app.
 */
function makeClient(getPatientProfile: Parameters<typeof createApp>[0]["getPatientProfile"]) {
  const app = createApp({
    log: () => undefined,
    checkMedplum: () => Promise.resolve(true),
    getPatientProfile,
  });
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    app.request(input, init)) as typeof fetch;
  return createApiClient({ baseUrl: "http://bff.test", fetch: fetchImpl });
}

describe("api-client ⇄ BFF contract", () => {
  it("round-trips a patient profile DTO", async () => {
    const client = makeClient((id) =>
      Promise.resolve({ id, name: "Synth Example", birthDate: "1990-01-01" }),
    );
    await expect(client.getPatientProfile("synth-1")).resolves.toEqual({
      id: "synth-1",
      name: "Synth Example",
      birthDate: "1990-01-01",
    });
  });

  it("maps the BFF's generic 404 to undefined", async () => {
    const client = makeClient(() => Promise.resolve(undefined));
    await expect(client.getPatientProfile("missing")).resolves.toBeUndefined();
  });
});
