import { describe, expect, it } from "vitest";

import { readApiConfigFromEnv } from "./config.js";

describe("readApiConfigFromEnv", () => {
  it("defaults the port to 3001 when PORT is unset", () => {
    expect(readApiConfigFromEnv({})).toEqual({ port: 3001 });
  });

  it("parses PORT from the environment", () => {
    expect(readApiConfigFromEnv({ PORT: "8080" })).toEqual({ port: 8080 });
  });

  it("throws on a non-numeric PORT", () => {
    expect(() => readApiConfigFromEnv({ PORT: "banana" })).toThrow(/PORT/);
  });
});
