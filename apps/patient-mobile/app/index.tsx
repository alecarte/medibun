import { tokens } from "@medibun/design-tokens";
import { Box, Text } from "../theme/restyle";

// Hello-world screen. Proves the mobile token pipeline: the design-tokens restyle theme
// drives colors/spacing through ThemeProvider, and a token value is read directly.
export default function Home() {
  return (
    <Box flex={1} backgroundColor="background" padding="xl" gap="m">
      <Text variant="heading">Aureva</Text>
      <Text variant="body">
        Scaffold online. Brand primary token: {tokens["brand-color-primary"]}
      </Text>
    </Box>
  );
}
