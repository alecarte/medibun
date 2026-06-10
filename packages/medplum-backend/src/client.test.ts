import { describe, it, expect } from "vitest";
import { readConfigFromEnv, createMedplumClient } from "./client.js";

describe("medplum-backend client config", () => {
  const good = {
    MEDPLUM_BASE_URL: "http://localhost:8103/",
    MEDPLUM_CLIENT_ID: "client-id",
    MEDPLUM_CLIENT_SECRET: "client-secret",
  };

  it("reads config from env", () => {
    const cfg = readConfigFromEnv(good);
    expect(cfg.baseUrl).toBe("http://localhost:8103/");
    expect(cfg.clientId).toBe("client-id");
  });

  it("throws listing every missing var", () => {
    expect(() => readConfigFromEnv({})).toThrowError(
      /MEDPLUM_BASE_URL.*MEDPLUM_CLIENT_ID.*MEDPLUM_CLIENT_SECRET/,
    );
  });

  it("constructs a client at the configured base url (no auth)", () => {
    const client = createMedplumClient(readConfigFromEnv(good));
    expect(client.getBaseUrl()).toContain("localhost:8103");
  });
});
