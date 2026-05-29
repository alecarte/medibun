import { describe, it, expect } from "vitest";
import { tokens, defaultTheme, brandVariableNames } from "./index.js";

describe("design-tokens", () => {
  it("exposes the brand color tokens the apps reference", () => {
    expect(tokens["brand-color-primary"]).toMatch(/^#[0-9a-f]{6}$/i);
    expect(tokens["brand-color-background"]).toBeDefined();
    expect(tokens["brand-color-foreground"]).toBeDefined();
  });

  it("builds a restyle theme whose colors mirror the brand tokens", () => {
    expect(defaultTheme.colors.primary).toBe(tokens["brand-color-primary"]);
    expect(defaultTheme.colors.background).toBe(tokens["brand-color-background"]);
    expect(Object.keys(defaultTheme.spacing)).toEqual(["s", "m", "l", "xl"]);
  });

  it("declares the runtime-theming contract (semantic brand variable names)", () => {
    expect(brandVariableNames).toContain("brand-color-primary");
    expect(brandVariableNames.length).toBeGreaterThan(0);
  });
});
