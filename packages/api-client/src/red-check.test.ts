import { describe, expect, it } from "vitest";

describe("CI red check (throwaway)", () => {
  it("deliberately fails to prove CI goes red", () => {
    expect(true).toBe(false);
  });
});
