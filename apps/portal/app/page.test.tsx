import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Home from "./page.js";

describe("portal home", () => {
  it("renders the shell headline", () => {
    render(<Home />);
    expect(
      screen.getByRole("heading", { name: "Care that feels like a ritual, not a queue." }),
    ).toBeInTheDocument();
  });

  it("shows the three journey cards", () => {
    render(<Home />);
    for (const title of ["Book a visit", "Your history", "Ask anything"]) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    }
  });

  it("links the booking card into the live flow (graduated with S4)", () => {
    render(<Home />);
    expect(screen.getByRole("link", { name: /Book a visit/ })).toHaveAttribute("href", "/book");
  });
});
