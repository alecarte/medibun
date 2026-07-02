import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { tokens } from "@medibun/design-tokens";
import { Sidebar } from "./sidebar";

describe("portal sidebar", () => {
  it("renders the wordmark from the brand-name token (no hardcoded brand)", () => {
    render(<Sidebar />);
    expect(screen.getByText(tokens["brand-name"])).toBeInTheDocument();
  });

  it("exposes primary navigation with Home active", () => {
    render(<Sidebar />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav).toBeInTheDocument();
    expect(screen.getByText("Home")).toHaveAttribute("aria-current", "page");
  });

  it("marks not-yet-built destinations as Soon (honest shell)", () => {
    render(<Sidebar />);
    expect(screen.getAllByText("Soon")).toHaveLength(3);
  });
});
