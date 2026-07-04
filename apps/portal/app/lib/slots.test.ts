import { describe, expect, it } from "vitest";

import {
  dayParts,
  dayStrip,
  formatDuration,
  formatPrice,
  formatSlotFull,
  formatSlotTime,
} from "./slots";

const TZ = "America/New_York";

describe("dayStrip", () => {
  it("renders every calendar day the window intersects, including empty ones", () => {
    // Window starts Monday July 6, 8:00 AM ET; 7*24h later is Monday July 13, 8:00 AM
    // ET — the window touches 8 calendar days and all 8 must render (honest fullness).
    const strip = dayStrip(
      [
        { start: "2026-07-06T15:00:00.000Z", end: "2026-07-06T15:30:00.000Z" },
        { start: "2026-07-09T14:00:00.000Z", end: "2026-07-09T14:30:00.000Z" },
      ],
      TZ,
      "2026-07-06T12:00:00.000Z",
      7,
    );
    expect(strip.map((d) => d.weekday)).toEqual([
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
      "Sun",
      "Mon",
    ]);
    expect(strip[0]).toMatchObject({ dayOfMonth: "6", dayLabel: "Monday, July 6" });
    expect(strip[0]!.slots).toHaveLength(1);
    expect(strip[1]!.slots).toHaveLength(0);
    expect(strip[3]!.slots).toHaveLength(1);
  });

  it("keeps a payload slot on the window's last calendar day reachable", () => {
    // Fetched at 2:00 PM ET Monday: a slot next Monday MORNING is inside the 168h
    // window but on the 8th calendar day — it must land on a rendered strip day.
    const strip = dayStrip(
      [{ start: "2026-07-13T13:00:00.000Z", end: "2026-07-13T13:30:00.000Z" }],
      TZ,
      "2026-07-06T18:00:00.000Z",
      7,
    );
    const lastDay = strip[strip.length - 1]!;
    expect(lastDay.dayLabel).toBe("Monday, July 13");
    expect(lastDay.slots).toHaveLength(1);
  });

  it("never duplicates a day across a DST fall-back (25-hour day)", () => {
    // Nov 1 2026, America/New_York: render at 00:30 EDT — the +24h-arithmetic bug
    // produced dayKey 2026-11-01 twice (duplicate React keys).
    const strip = dayStrip([], TZ, "2026-11-01T04:30:00.000Z", 7);
    const keys = strip.map((d) => d.dayKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe("2026-11-01");
    expect(keys).toContain("2026-11-07");
  });

  it("never skips a day across a DST spring-forward (23-hour day)", () => {
    // Mar 8 2026, America/New_York: render at 23:30 EST Mar 7 — the +24h-arithmetic
    // bug skipped Mar 8 entirely, orphaning its slots.
    const strip = dayStrip(
      [{ start: "2026-03-08T15:00:00.000Z", end: "2026-03-08T15:30:00.000Z" }],
      TZ,
      "2026-03-08T04:30:00.000Z",
      7,
    );
    const mar8 = strip.find((d) => d.dayKey === "2026-03-08");
    expect(mar8).toBeDefined();
    expect(mar8!.slots).toHaveLength(1);
    const keys = strip.map((d) => d.dayKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("buckets by practice-timezone day and keeps each day's slots chronological", () => {
    const strip = dayStrip(
      [
        // 23:30 EDT on Jul 9 is 03:30Z Jul 10 — the practice day must win the bucket.
        { start: "2026-07-10T03:30:00.000Z", end: "2026-07-10T04:00:00.000Z" },
        { start: "2026-07-09T15:00:00.000Z", end: "2026-07-09T15:30:00.000Z" },
        { start: "2026-07-09T14:00:00.000Z", end: "2026-07-09T14:30:00.000Z" },
      ],
      TZ,
      "2026-07-06T12:00:00.000Z",
      7,
    );
    const thursday = strip.find((d) => d.dayKey === "2026-07-09")!;
    expect(thursday.slots.map((s) => s.start)).toEqual([
      "2026-07-09T14:00:00.000Z",
      "2026-07-09T15:00:00.000Z",
      "2026-07-10T03:30:00.000Z",
    ]);
  });
});

describe("dayParts", () => {
  it("buckets a day's slots into morning, afternoon, and evening (practice tz)", () => {
    const parts = dayParts(
      [
        { start: "2026-07-06T13:30:00.000Z", end: "2026-07-06T14:00:00.000Z" }, // 9:30 AM ET
        { start: "2026-07-06T18:00:00.000Z", end: "2026-07-06T18:30:00.000Z" }, // 2:00 PM ET
        { start: "2026-07-06T22:00:00.000Z", end: "2026-07-06T22:30:00.000Z" }, // 6:00 PM ET
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
