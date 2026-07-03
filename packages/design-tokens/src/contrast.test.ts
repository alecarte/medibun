import { describe, it, expect } from "vitest";
import { brandThemes, type Theme } from "./index.js";

/** WCAG 2.1 relative luminance + contrast ratio (sRGB). */
const channel = (v: number): number => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string): number => {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`not a 6-digit hex color: ${hex}`);
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 0xff) +
    0.7152 * channel((n >> 8) & 0xff) +
    0.0722 * channel(n & 0xff)
  );
};
const contrast = (a: string, b: string): number => {
  const [la, lb] = [luminance(a), luminance(b)];
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

const AA_TEXT = 4.5;
const AA_UI = 3;

const cases: [string, Theme][] = Object.entries(brandThemes);

describe.each(cases)("brand %s — WCAG 2.1 AA", (_name, t) => {
  it("primary text meets AA on every surface it sits on", () => {
    for (const surface of [t.colors.surfaceCanvas, t.colors.surfaceCard, t.colors.surfaceWell]) {
      expect(contrast(t.colors.textPrimary, surface)).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it("secondary text meets AA on canvas and card", () => {
    for (const surface of [t.colors.surfaceCanvas, t.colors.surfaceCard]) {
      expect(contrast(t.colors.textSecondary, surface)).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it("the brand accent works as normal text on canvas and card (no per-brand exceptions)", () => {
    for (const surface of [t.colors.surfaceCanvas, t.colors.surfaceCard]) {
      expect(contrast(t.colors.primary, surface)).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it("accent-contrast text meets AA on the accent (buttons)", () => {
    expect(contrast(t.colors.primaryContrast, t.colors.primary)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("interactive borders/icons meet the 3:1 UI-component minimum on card", () => {
    expect(contrast(t.colors.borderInteractive, t.colors.surfaceCard)).toBeGreaterThanOrEqual(
      AA_UI,
    );
  });

  it("every status text meets AA on its wash (chips are never color-alone)", () => {
    for (const status of ["success", "warning", "danger", "info"] as const) {
      expect(contrast(t.colors[`${status}Text`], t.colors[`${status}Wash`])).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
    }
  });
});

describe("categorical service colors — WCAG 2.1 AA", () => {
  const CATEGORIES = ["sage", "teal", "indigo", "plum", "clay", "slate"] as const;

  it("every category text meets AA on its wash (calendar blocks)", async () => {
    const { tokens } = await import("./tokens.generated.js");
    const t = tokens as Record<string, string>;
    for (const c of CATEGORIES) {
      const text = t[`color-category-${c}-text`]!;
      const wash = t[`color-category-${c}-wash`]!;
      expect(text, `${c} text token missing`).toBeDefined();
      expect(contrast(text, wash), `${c}: ${text} on ${wash}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
