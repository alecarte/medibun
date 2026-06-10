import { afterEach, describe, expect, it, vi } from "vitest";

import DevPatientPage from "./page";

describe("dev patient page", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is not served in production builds", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(DevPatientPage({ searchParams: Promise.resolve({}) })).rejects.toThrow();
  });

  it("prompts for an id outside production", async () => {
    const jsx = await DevPatientPage({ searchParams: Promise.resolve({}) });
    expect(JSON.stringify(jsx)).toContain("?id=");
  });
});
