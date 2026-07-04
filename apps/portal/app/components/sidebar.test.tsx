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

  it("collapses by fading labels — they never unmount, so names and layout survive", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    // Animation discipline: labels stay in the DOM and fade (opacity), so text can't
    // judder mid-transition and links keep their accessible names in both states.
    expect(screen.getByText("Home")).toHaveClass("opacity-0");
    expect(screen.getByRole("link", { name: "Home" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Book a visit" })).toBeInTheDocument();
    // Unbuilt destinations keep their honest label + "Soon" chip in the tree too.
    expect(screen.getByText("Your history")).toBeInTheDocument();
    expect(screen.getByText("Ask")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(screen.getByText("Home")).toHaveClass("opacity-100");
  });

  it("swaps the logotype for the brand icon mark when collapsed (letter fallback)", () => {
    render(<Sidebar />);
    // No practice icon asset yet — the fallback mark is the practice name's first
    // letter on the brand theme color. Expanded shows the logotype instead.
    const mark = screen.getByText(tokens["brand-name"].charAt(0));
    expect(mark).toHaveClass("opacity-0");
    expect(screen.getByText(tokens["brand-name"])).toHaveClass("opacity-100");
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(mark).toHaveClass("opacity-100");
    expect(screen.getByText(tokens["brand-name"])).toHaveClass("opacity-0");
    // The wordmark keeps the accessible name in both states; the mark is decorative.
    expect(mark).toHaveAttribute("aria-hidden");
  });

  it("toggles with ⌘/Ctrl+B, but never steals the shortcut from a text field", () => {
    render(<Sidebar />);
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "B", metaKey: true });
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
    // Modified variants (⌘⇧B etc.) belong to other tools — leave them alone.
    fireEvent.keyDown(window, { key: "b", ctrlKey: true, shiftKey: true });
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
    // Typing in a form control must not toggle the shell.
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "b", ctrlKey: true });
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
    input.remove();
  });

  it("persists the preference as a cookie and honors the server-read initial state", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(document.cookie).toContain("medibun_sidebar=1");
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(document.cookie).toContain("medibun_sidebar=0");
    // A fresh render with the server-read cookie value starts collapsed — the first
    // paint is already right, no post-hydration flash (code-review fix).
    render(<Sidebar initialCollapsed />);
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
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
