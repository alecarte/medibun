import { describe, expect, it } from "vitest";

import { readApiConfigFromEnv } from "./config.js";

describe("readApiConfigFromEnv", () => {
  it("defaults to port 3001 with dev routes off", () => {
    expect(readApiConfigFromEnv({})).toEqual({ port: 3001, devUnauthenticatedRoutes: false });
  });

  it("parses PORT from the environment", () => {
    expect(readApiConfigFromEnv({ PORT: "8080" }).port).toBe(8080);
  });

  it("refuses to start with dev unauthenticated routes in production", () => {
    expect(() =>
      readApiConfigFromEnv({ API_DEV_UNAUTHENTICATED: "1", NODE_ENV: "production" }),
    ).toThrow(/API_DEV_UNAUTHENTICATED/);
  });

  it("enables dev unauthenticated routes only on the exact opt-in value", () => {
    expect(readApiConfigFromEnv({ API_DEV_UNAUTHENTICATED: "1" }).devUnauthenticatedRoutes).toBe(
      true,
    );
    expect(readApiConfigFromEnv({ API_DEV_UNAUTHENTICATED: "true" }).devUnauthenticatedRoutes).toBe(
      false,
    );
  });

  it("throws on a non-numeric PORT", () => {
    expect(() => readApiConfigFromEnv({ PORT: "banana" })).toThrow(/PORT/);
  });
});
