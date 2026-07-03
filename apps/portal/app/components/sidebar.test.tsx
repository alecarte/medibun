import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { tokens } from "@medibun/design-tokens";
import { Sidebar } from "./sidebar";
import { vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

describe("portal sidebar", () => {
  it("renders the wordmark from the brand-name token (no hardcoded brand)", () => {
    render(<Sidebar />);
    expect(screen.getByText(tokens["brand-name"])).toBeInTheDocument();
  });

  it("exposes primary navigation with Home active", () => {
    render(<Sidebar />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
  });

  it("collapses to icons and back, keeping accessible names", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    // Labels leave the DOM; the links stay reachable by their aria-labels.
    expect(screen.queryByText("Home")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Home" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Book a visit" })).toBeInTheDocument();
    expect(screen.queryByText("Soon")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(screen.getByText("Home")).toBeInTheDocument();
  });

  it("marks not-yet-built destinations as Soon (honest shell)", () => {
    render(<Sidebar />);
    // History (S9) and Ask (S10) remain; booking graduated to a real link with S4.
    expect(screen.getAllByText("Soon")).toHaveLength(2);
  });

  it("links Book a visit to the booking flow (graduated with S4)", () => {
    render(<Sidebar />);
    expect(screen.getByRole("link", { name: "Book a visit" })).toHaveAttribute("href", "/book");
  });
});

describe("portal sidebar — signed in", () => {
  it("shows the account entry and the signed-in identity instead of the sign-in CTA", () => {
    render(<Sidebar profileName="Synthia Loginsmith" />);
    expect(screen.getByRole("link", { name: "Your account" })).toBeInTheDocument();
    expect(screen.getByText("Synthia Loginsmith")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("shows the wallet balance in the profile card (truthful zero until commerce)", () => {
    render(<Sidebar profileName="Synthia Loginsmith" />);
    const profile = screen.getByText("Synthia Loginsmith").closest("a");
    expect(profile).toHaveTextContent("$0");
  });

  it("shows the sign-in CTA when signed out", () => {
    render(<Sidebar />);
    expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Your account" })).not.toBeInTheDocument();
  });
});
