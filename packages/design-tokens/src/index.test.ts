import { describe, it, expect } from "vitest";
import { tokens, defaultTheme, brandThemes, brandVariableNames } from "./index.js";
import { tokens as handalTokens } from "./tokens.handal.generated.js";

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

  it("emits identical token key sets for every brand — brands are themes, not forks", () => {
    expect(Object.keys(handalTokens).sort()).toEqual(Object.keys(tokens).sort());
  });

  it("every declared brand variable exists in every brand's tokens", () => {
    const handal: Record<string, string> = handalTokens;
    for (const name of brandVariableNames) {
      expect(tokens[name], `${name} missing from aureva`).toBeDefined();
      expect(handal[name], `${name} missing from handal`).toBeDefined();
    }
  });

  it("exposes identical restyle theme shapes for every brand (cross-platform contract)", () => {
    expect(Object.keys(brandThemes.handal.colors).sort()).toEqual(
      Object.keys(brandThemes.aureva.colors).sort(),
    );
    expect(Object.keys(brandThemes.handal.borderRadii).sort()).toEqual(
      Object.keys(brandThemes.aureva.borderRadii).sort(),
    );
  });

  it("brands differ only in brand values (placeholder swap stays one file)", () => {
    expect(brandThemes.handal.colors.primary).not.toBe(brandThemes.aureva.colors.primary);
    expect(brandThemes.handal.borderRadii.control).not.toBe(brandThemes.aureva.borderRadii.control);
    // Non-brand primitives stay constant across brands.
    expect(brandThemes.handal.colors.surfaceCard).toBe(brandThemes.aureva.colors.surfaceCard);
    expect(brandThemes.handal.colors.borderHairline).toBe(brandThemes.aureva.colors.borderHairline);
  });
});
