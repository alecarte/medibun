import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Home from "./page.js";

describe("staff home", () => {
  it("renders the Today heading", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();
  });

  it("shows the empty day sheet with its explanation", () => {
    render(<Home />);
    expect(screen.getByText(/No appointments yet/)).toBeInTheDocument();
  });
});
