import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
import { tokens } from "@medibun/design-tokens";
import { Sidebar } from "./sidebar";

/** The desktop rail (jsdom renders both shells; CSS hides one per breakpoint). */
const rail = () => within(screen.getByRole("complementary"));

describe("staff sidebar", () => {
  it("renders the wordmark from the brand-name token (no hardcoded brand)", () => {
    render(<Sidebar />);
    expect(rail().getByText(tokens["brand-name"])).toBeInTheDocument();
  });

  it("exposes primary navigation with Today active", () => {
    render(<Sidebar />);
    expect(rail().getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(rail().getByText("Today").closest("[aria-current]")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("marks not-yet-built destinations as Soon (honest shell)", () => {
    render(<Sidebar />);
    expect(rail().getAllByText("Soon")).toHaveLength(2);
  });

  it("collapses by fading labels (never unmounting) and persists its own cookie", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(rail().getByText("Today")).toHaveClass("opacity-0");
    // Distinct cookie from the portal's: localhost ports share one cookie jar.
    expect(document.cookie).toContain("medibun_staff_sidebar=1");
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(rail().getByText("Today")).toHaveClass("opacity-100");
    expect(document.cookie).toContain("medibun_staff_sidebar=0");
  });

  it("shows the brand icon mark (letter fallback) when collapsed, honors initial state", () => {
    render(<Sidebar initialCollapsed />);
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    const mark = rail().getByText(tokens["brand-name"].charAt(0));
    expect(mark).toHaveClass("opacity-100");
    expect(mark).toHaveAttribute("aria-hidden");
  });

  it("toggles with ⌘/Ctrl+B, but never steals the shortcut from a text field", () => {
    render(<Sidebar />);
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "B", metaKey: true });
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "b", ctrlKey: true });
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
    input.remove();
  });

  it("opens the mobile drawer from the top bar and closes on Escape", () => {
    render(<Sidebar />);
    expect(screen.queryByRole("dialog", { name: "Menu" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const drawer = within(screen.getByRole("dialog", { name: "Menu" }));
    expect(drawer.getByText("Today")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Menu" })).not.toBeInTheDocument();
  });
});
