import { createTheme } from "@shopify/restyle";
import { defaultTheme } from "@medibun/design-tokens";

/**
 * The restyle theme for the mobile app, built from the shared design tokens. The same
 * semantic token names back the web CSS variables, so a brand swap stays consistent
 * across platforms. The future settings GUI swaps the active theme via ThemeProvider —
 * this is the mobile half of the runtime-theming contract.
 */
export const theme = createTheme({
  colors: defaultTheme.colors,
  spacing: defaultTheme.spacing,
  borderRadii: defaultTheme.borderRadii,
  textVariants: {
    defaults: {
      color: "foreground",
    },
    heading: {
      color: "primary",
      fontSize: 24,
      fontWeight: "600",
    },
    body: {
      color: "muted",
      fontSize: 16,
    },
  },
});

export type Theme = typeof theme;
