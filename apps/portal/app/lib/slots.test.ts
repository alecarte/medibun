import { describe, expect, it } from "vitest";

import {
  dayParts,
  dayStrip,
  formatDuration,
  formatPrice,
  formatSlotFull,
  formatSlotTime,
  groupSlotsByDay,
} from "./slots";

const TZ = "America/New_York";

describe("groupSlotsByDay", () => {
  it("buckets slots by practice-timezone day, chronologically", () => {
    const groups = groupSlotsByDay(
      [
        // Out of order on purpose; 23:30 EDT on Jul 9 is 03:30Z Jul 10 — the practice
        // day, not the UTC day, must win the grouping.
        { start: "2026-07-10T03:30:00.000Z", end: "2026-07-10T04:00:00.000Z" },
        { start: "2026-07-09T14:00:00.000Z", end: "2026-07-09T14:30:00.000Z" },
        { start: "2026-07-09T15:00:00.000Z", end: "2026-07-09T15:30:00.000Z" },
      ],
      TZ,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.dayLabel).toBe("Thursday, July 9");
    expect(groups[0]!.slots.map((s) => s.start)).toEqual([
      "2026-07-09T14:00:00.000Z",
      "2026-07-09T15:00:00.000Z",
      "2026-07-10T03:30:00.000Z",
    ]);
  });

  it("keeps distinct days in chronological order", () => {
    const groups = groupSlotsByDay(
      [
        { start: "2026-07-10T14:00:00.000Z", end: "2026-07-10T14:30:00.000Z" },
        { start: "2026-07-09T14:00:00.000Z", end: "2026-07-09T14:30:00.000Z" },
      ],
      TZ,
    );
    expect(groups.map((g) => g.dayLabel)).toEqual(["Thursday, July 9", "Friday, July 10"]);
  });
});

describe("dayStrip", () => {
  it("renders all 7 window days including empty ones (honest fullness)", () => {
    // from = Monday July 6 in America/New_York (10:00 local).
    const from = new Date("2026-07-06T14:00:00.000Z");
    const strip = dayStrip(
      [
        { start: "2026-07-06T15:00:00.000Z", end: "2026-07-06T15:30:00.000Z" },
        { start: "2026-07-09T14:00:00.000Z", end: "2026-07-09T14:30:00.000Z" },
      ],
      TZ,
      from,
    );
    expect(strip).toHaveLength(7);
    expect(strip.map((d) => d.weekday)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(strip[0]).toMatchObject({ dayOfMonth: "6", dayLabel: "Monday, July 6" });
    expect(strip[0]!.slots).toHaveLength(1);
    expect(strip[1]!.slots).toHaveLength(0);
    expect(strip[3]!.slots).toHaveLength(1);
  });
});

describe("dayParts", () => {
  it("buckets a day's slots into morning, afternoon, and evening (practice tz)", () => {
    const parts = dayParts(
      [
        { start: "2026-07-06T22:00:00.000Z", end: "2026-07-06T22:30:00.000Z" }, // 6:00 PM ET
        { start: "2026-07-06T13:30:00.000Z", end: "2026-07-06T14:00:00.000Z" }, // 9:30 AM ET
        { start: "2026-07-06T18:00:00.000Z", end: "2026-07-06T18:30:00.000Z" }, // 2:00 PM ET
      ],
      TZ,
    );
    expect(parts.map((p) => p.label)).toEqual(["Morning", "Afternoon", "Evening"]);
    expect(parts[0]!.slots[0]!.start).toBe("2026-07-06T13:30:00.000Z");
  });

  it("omits empty buckets", () => {
    const parts = dayParts(
      [{ start: "2026-07-06T13:30:00.000Z", end: "2026-07-06T14:00:00.000Z" }],
      TZ,
    );
    expect(parts.map((p) => p.label)).toEqual(["Morning"]);
  });
});

describe("formatting", () => {
  it("formats slot times in the practice timezone", () => {
    expect(formatSlotTime("2026-07-09T14:00:00.000Z", TZ)).toBe("10:00 AM");
  });

  it("states the confirmation outcome in full", () => {
    expect(formatSlotFull("2026-07-09T18:30:00.000Z", TZ)).toBe("Thursday, July 9 at 2:30 PM");
  });

  it("formats whole-dollar prices without cents", () => {
    expect(formatPrice(39_500)).toBe("$395");
    expect(formatPrice(39_550)).toBe("$395.50");
  });

  it("formats durations in minutes", () => {
    expect(formatDuration(30)).toBe("30 min");
  });
});
