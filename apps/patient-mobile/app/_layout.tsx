import { ThemeProvider } from "@shopify/restyle";
import { Stack } from "expo-router";
import { theme } from "../theme";

// ThemeProvider is the runtime-theming seam on mobile: swapping the theme value here
// (per brand, driven by the future settings GUI) re-themes the app — the mobile mirror
// of the web [data-brand] CSS-variable scope.
export default function RootLayout() {
  return (
    <ThemeProvider theme={theme}>
      <Stack />
    </ThemeProvider>
  );
}
