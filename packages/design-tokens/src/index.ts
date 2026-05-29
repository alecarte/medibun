import { tokens } from "./tokens.generated.js";

export { tokens } from "./tokens.generated.js";
export type { TokenName } from "./tokens.generated.js";

/**
 * The semantic CSS-variable names that form the runtime-theming contract. Both web
 * (CSS custom properties) and mobile (restyle theme) expose the same names, so the
 * future settings GUI can swap a brand by overriding this one set on either platform.
 */
export const brandVariableNames = [
  "brand-color-primary",
  "brand-color-primary-contrast",
  "brand-color-background",
  "brand-color-foreground",
  "brand-color-muted",
] as const;

/**
 * The default restyle theme object for the mobile app. Mirrors the same tokens the web
 * apps consume as CSS variables. A brand swap replaces this object via restyle's
 * ThemeProvider; the semantic keys stay identical across platforms.
 */
export const defaultTheme = {
  colors: {
    primary: tokens["brand-color-primary"],
    primaryContrast: tokens["brand-color-primary-contrast"],
    background: tokens["brand-color-background"],
    foreground: tokens["brand-color-foreground"],
    muted: tokens["brand-color-muted"],
  },
  spacing: {
    s: tokens["space-2"],
    m: tokens["space-4"],
    l: tokens["space-6"],
    xl: tokens["space-8"],
  },
  borderRadii: {
    sm: tokens["radius-sm"],
    md: tokens["radius-md"],
    lg: tokens["radius-lg"],
    full: tokens["radius-full"],
  },
} as const;

export type Theme = typeof defaultTheme;
