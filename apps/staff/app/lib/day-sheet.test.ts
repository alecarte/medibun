import { describe, expect, it } from "vitest";

import {
  blockGeometry,
  daySpan,
  formatColumnDay,
  formatDateHeading,
  formatHour,
  formatMonthYear,
  formatTime,
  formatToolbarDate,
  FORWARD_ACTIONS,
  HOUR_PX,
  hourOf,
  hourRange,
  monthGrid,
  shiftYmd,
  weekStart,
  ymdOf,
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

describe("calendar math", () => {
  it("shiftYmd moves by whole days across month and year boundaries", () => {
    expect(shiftYmd("2026-07-06", 1)).toBe("2026-07-07");
    expect(shiftYmd("2026-07-31", 1)).toBe("2026-08-01");
    expect(shiftYmd("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftYmd("2026-07-06", 7)).toBe("2026-07-13");
  });

  it("weekStart snaps to the Monday of the week", () => {
    expect(weekStart("2026-07-08")).toBe("2026-07-06"); // Wed → Mon
    expect(weekStart("2026-07-06")).toBe("2026-07-06"); // Mon → itself
    expect(weekStart("2026-07-05")).toBe("2026-06-29"); // Sun → prior Mon
  });

  it("daySpan lists N consecutive dates", () => {
    expect(daySpan("2026-07-06", 3)).toEqual(["2026-07-06", "2026-07-07", "2026-07-08"]);
  });

  it("ymdOf buckets an instant into its practice-local date", () => {
    // 01:00Z on the 5th is still the 4th in America/New_York (EDT).
    expect(ymdOf("2026-07-05T01:00:00.000Z", TZ)).toBe("2026-07-04");
  });
});

describe("date labels", () => {
  it("formatToolbarDate shows a weekday for a day and a range for a week", () => {
    expect(formatToolbarDate("2026-07-06", 1)).toBe("Mon, Jul 6");
    expect(formatToolbarDate("2026-07-06", 7)).toBe("Jul 6 – 12"); // same month collapses
    expect(formatToolbarDate("2026-06-29", 7)).toBe("Jun 29 – Jul 5"); // crosses month
  });

  it("formatColumnDay gives a week-column header", () => {
    expect(formatColumnDay("2026-07-06")).toEqual({ weekday: "Mon", day: "6" });
  });

  it("formatMonthYear labels the mini-calendar", () => {
    expect(formatMonthYear("2026-07-06")).toBe("July 2026");
  });
});

describe("monthGrid", () => {
  it("returns a stable 42-cell Monday-first grid flagging in-month days", () => {
    const grid = monthGrid("2026-07-15");
    expect(grid).toHaveLength(42);
    // July 2026 starts on a Wednesday; the grid's first cell is the Monday before.
    expect(grid[0]!.date).toBe("2026-06-29");
    expect(grid[0]!.inMonth).toBe(false);
    const first = grid.find((c) => c.date === "2026-07-01")!;
    expect(first.inMonth).toBe(true);
    expect(grid.filter((c) => c.inMonth)).toHaveLength(31);
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
