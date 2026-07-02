import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { tokens } from "@medibun/design-tokens";
import Home from "./page.js";

describe("portal home", () => {
  it("renders the shell headline", () => {
    render(<Home />);
    expect(
      screen.getByRole("heading", { name: "Care that feels like a ritual, not a queue." }),
    ).toBeInTheDocument();
  });

  it("renders the wordmark from the brand-name token (no hardcoded brand)", () => {
    render(<Home />);
    expect(screen.getByText(tokens["brand-name"])).toBeInTheDocument();
  });

  it("shows the three journey cards", () => {
    render(<Home />);
    for (const title of ["Book a visit", "Your history", "Ask anything"]) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    }
  });
});
