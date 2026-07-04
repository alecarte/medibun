import { describe, expect, it } from "vitest";

import {
  blockGeometry,
  formatDateHeading,
  formatHour,
  formatTime,
  FORWARD_ACTIONS,
  HOUR_PX,
  hourOf,
  hourRange,
} from "./day-sheet";

const TZ = "America/New_York";

describe("hourOf", () => {
  it("converts an instant to a fractional practice-local hour", () => {
    // 18:30Z = 14:30 EDT
    expect(hourOf("2026-07-04T18:30:00.000Z", TZ)).toBe(14.5);
  });
});

describe("hourRange", () => {
  it("defaults to practice hours 9–17 with no appointments", () => {
    expect(hourRange([], TZ)).toEqual({ startHour: 9, endHour: 17 });
  });

  it("stretches to fit early and late appointments", () => {
    const appts = [
      { start: "2026-07-04T11:30:00.000Z", end: "2026-07-04T12:00:00.000Z" }, // 7:30 EDT
      { start: "2026-07-04T22:30:00.000Z", end: "2026-07-04T23:15:00.000Z" }, // ends 19:15
    ] as never[];
    expect(hourRange(appts, TZ)).toEqual({ startHour: 7, endHour: 20 });
  });
});

describe("blockGeometry", () => {
  it("positions a block by practice-local time from the grid start", () => {
    // 14:00–14:30 EDT on a grid starting at 9
    const g = blockGeometry(
      { start: "2026-07-04T18:00:00.000Z", end: "2026-07-04T18:30:00.000Z" },
      TZ,
      9,
    );
    expect(g.top).toBe(5 * HOUR_PX);
    expect(g.height).toBe(HOUR_PX / 2);
  });

  it("never renders a sliver below the clickable minimum", () => {
    const g = blockGeometry(
      { start: "2026-07-04T18:00:00.000Z", end: "2026-07-04T18:00:00.000Z" },
      TZ,
      9,
    );
    expect(g.height).toBe(28);
  });
});

describe("formatting", () => {
  it("renders times in the practice timezone, not the device's", () => {
    expect(formatTime("2026-07-04T18:00:00.000Z", TZ)).toBe("2:00 PM");
  });

  it("renders gutter hour labels", () => {
    expect(formatHour(9)).toBe("9 AM");
    expect(formatHour(12)).toBe("12 PM");
    expect(formatHour(17)).toBe("5 PM");
  });

  it("renders the date heading from the practice-local date string", () => {
    expect(formatDateHeading("2026-07-04")).toBe("Saturday, July 4");
  });
});

describe("FORWARD_ACTIONS", () => {
  it("offers exactly the forward workflow (undo lives in the toast, not the menu)", () => {
    expect(FORWARD_ACTIONS.scheduled.map((a) => a.to)).toEqual(["arrived", "no-show"]);
    expect(FORWARD_ACTIONS.arrived.map((a) => a.to)).toEqual(["roomed"]);
    expect(FORWARD_ACTIONS.roomed.map((a) => a.to)).toEqual(["completed"]);
    expect(FORWARD_ACTIONS.completed).toEqual([]);
    expect(FORWARD_ACTIONS["no-show"]).toEqual([]);
  });
});
