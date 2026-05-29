import { render, screen } from "@testing-library/react-native";
import { ThemeProvider } from "@shopify/restyle";
import Home from "../app/index";
import { theme } from "../theme";

describe("patient-mobile home", () => {
  it("renders the heading and the brand token value", () => {
    render(
      <ThemeProvider theme={theme}>
        <Home />
      </ThemeProvider>,
    );
    expect(screen.getByText("Aureva")).toBeTruthy();
    expect(screen.getByText(/#6941c6/i)).toBeTruthy();
  });
});
