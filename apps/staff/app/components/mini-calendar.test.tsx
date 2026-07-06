import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { MiniCalendar } from "./mini-calendar";

const setup = () => {
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(<MiniCalendar selected="2026-07-06" weekMode={false} onPick={onPick} onClose={onClose} />);
  return { onPick, onClose };
};

describe("MiniCalendar", () => {
  it("moves the cursor by day/week with arrows and picks with Enter", () => {
    const { onPick } = setup();
    const start = screen.getByRole("gridcell", { name: "2026-07-06" });
    fireEvent.keyDown(start, { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByRole("gridcell", { name: "2026-07-07" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("gridcell", { name: "2026-07-14" }), { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("2026-07-14");
  });

  it("keeps the chevrons and the keyboard cursor on ONE month (no desync)", () => {
    // Regression: with a separate month anchor, paging with the chevron and then
    // pressing an arrow snapped the visible grid back to the old cursor's month.
    const { onPick } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByText("August 2026")).toBeInTheDocument();
    const cursor = screen.getByRole("gridcell", { name: "2026-08-01" });
    fireEvent.keyDown(cursor, { key: "ArrowRight" });
    expect(screen.getByText("August 2026")).toBeInTheDocument(); // still August
    fireEvent.keyDown(screen.getByRole("gridcell", { name: "2026-08-02" }), { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("2026-08-02");
  });

  it("pages backward to the previous month's first day", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByText("June 2026")).toBeInTheDocument();
    expect(screen.getByRole("gridcell", { name: "2026-06-01" })).toHaveAttribute(
      "data-cursor",
      "true",
    );
  });

  it("closes on Escape", () => {
    const { onClose } = setup();
    fireEvent.keyDown(screen.getByRole("gridcell", { name: "2026-07-06" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
