import { describe, expect, it } from "vitest";

import { readApiConfigFromEnv } from "./config.js";

describe("readApiConfigFromEnv", () => {
  it("defaults to port 3001", () => {
    expect(readApiConfigFromEnv({})).toEqual({ port: 3001 });
  });

  it("parses PORT from the environment", () => {
    expect(readApiConfigFromEnv({ PORT: "8080" }).port).toBe(8080);
  });

  it("ignores the removed dev-route flag (unauthenticated reads are gone for good)", () => {
    // API_DEV_UNAUTHENTICATED was deleted with the portal-login slice (docs/AUTH.md:
    // replace, not extend). A stale .env must not resurrect anything.
    expect(readApiConfigFromEnv({ API_DEV_UNAUTHENTICATED: "1" })).toEqual({ port: 3001 });
  });

  it("throws on a non-numeric PORT", () => {
    expect(() => readApiConfigFromEnv({ PORT: "banana" })).toThrow(/PORT/);
  });
});
