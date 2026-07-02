import { render, screen } from "@testing-library/react-native";
import { ThemeProvider } from "@shopify/restyle";
import { tokens } from "@medibun/design-tokens";
import Home from "../app/index";
import { theme } from "../theme";

describe("patient-mobile home", () => {
  it("renders the brand-name heading and the brand token value", () => {
    render(
      <ThemeProvider theme={theme}>
        <Home />
      </ThemeProvider>,
    );
    expect(screen.getByText(tokens["brand-name"])).toBeTruthy();
    expect(screen.getByText(new RegExp(tokens["brand-color-primary"], "i"))).toBeTruthy();
  });
});
