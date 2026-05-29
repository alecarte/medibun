import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Home from "./page.js";

describe("portal home", () => {
  it("renders the heading and the brand token value", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { name: "Aureva Portal" })).toBeInTheDocument();
    expect(screen.getByText(/#6941c6/i)).toBeInTheDocument();
  });
});
