import { tokens } from "./tokens.generated.js";
import { tokens as handalTokens } from "./tokens.handal.generated.js";
import type { TokenName } from "./tokens.generated.js";

export { tokens } from "./tokens.generated.js";
export type { TokenName } from "./tokens.generated.js";

/**
 * The brand-scoped variable names that form the runtime-theming contract. Both web
 * (CSS custom properties under [data-brand]) and mobile (restyle theme) expose the same
 * names, so a practice's brand is swapped by overriding this one set on either platform.
 * Real branding is in progress externally; current values are placeholders — swapping
 * them is a change to tokens/brand.<name>.json only (docs/V0_PROPOSAL.md §6).
 */
/** Categorical color keys for service/visit types (color.category.* tokens). The DB and
 *  seeds reference these keys; deriving types from this array keeps them in lockstep. */
export const categoryColors = ["sage", "teal", "indigo", "plum", "clay", "slate"] as const;
export type CategoryColor = (typeof categoryColors)[number];

export const brandVariableNames = [
  "brand-name",
  "brand-logo",
  "brand-color-primary",
  "brand-color-primary-contrast",
  "brand-color-background",
  "brand-color-foreground",
  "brand-color-muted",
  "brand-color-wash",
  "brand-color-glow",
  "brand-radius-control",
  "brand-font-display-settings",
] as const;

/**
 * Dimension tokens are authored as `px` strings (for web CSS variables); React Native
 * needs unitless numbers, so spacing/radii are parsed to numbers here for restyle.
 */
const px = (value: string): number => Number.parseFloat(value);

type TokenMap = Record<TokenName, string>;

/** Build a restyle theme from a brand's resolved token map. Semantic keys are identical
 *  across brands and platforms — the cross-platform theming contract. */
const makeTheme = (t: TokenMap) => ({
  colors: {
    primary: t["brand-color-primary"],
    primaryContrast: t["brand-color-primary-contrast"],
    background: t["brand-color-background"],
    foreground: t["brand-color-foreground"],
    muted: t["brand-color-muted"],
    wash: t["brand-color-wash"],
    glow: t["brand-color-glow"],
    surfaceCanvas: t["color-surface-canvas"],
    surfaceCard: t["color-surface-card"],
    surfaceWell: t["color-surface-well"],
    textPrimary: t["color-text-primary"],
    textSecondary: t["color-text-secondary"],
    textOnAccent: t["color-text-on-accent"],
    borderHairline: t["color-border-hairline"],
    borderInteractive: t["color-border-interactive"],
    actionPrimary: t["color-action-primary"],
    successText: t["color-status-success-text"],
    successWash: t["color-status-success-wash"],
    warningText: t["color-status-warning-text"],
    warningWash: t["color-status-warning-wash"],
    dangerText: t["color-status-danger-text"],
    dangerWash: t["color-status-danger-wash"],
    infoText: t["color-status-info-text"],
    infoWash: t["color-status-info-wash"],
  },
  spacing: {
    s: px(t["space-2"]),
    m: px(t["space-4"]),
    l: px(t["space-6"]),
    xl: px(t["space-8"]),
  },
  borderRadii: {
    sm: px(t["radius-sm"]),
    md: px(t["radius-md"]),
    lg: px(t["radius-lg"]),
    full: px(t["radius-full"]),
    control: px(t["brand-radius-control"]),
  },
});

/** One restyle theme per practice. A brand swap replaces the object via restyle's
 *  ThemeProvider; the semantic keys stay identical across brands and platforms. */
export const brandThemes = {
  aureva: makeTheme(tokens),
  handal: makeTheme(handalTokens),
} as const;

export const defaultTheme = brandThemes.aureva;
export type Theme = typeof defaultTheme;
