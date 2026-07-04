import type { AvailabilitySlot } from "@medibun/api-client";

/**
 * Slot/price presentation helpers. All times render in the PRACTICE timezone (the
 * practitioner's IANA zone from the availability DTO) — a visit happens at the studio,
 * not in the browser's zone. Numbers are always tabular (DESIGN.md).
 */

// Intl.DateTimeFormat construction is expensive and the picker formats one label per
// slot per render — cache per timezone (one practice timezone per page in practice).
const memoized = (build: (timezone: string) => Intl.DateTimeFormat) => {
  const byTz = new Map<string, Intl.DateTimeFormat>();
  return (timezone: string): Intl.DateTimeFormat => {
    let format = byTz.get(timezone);
    if (!format) {
      format = build(timezone);
      byTz.set(timezone, format);
    }
    return format;
  };
};

const dayKeyFormat = memoized(
  (timeZone) => new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }),
);
const dayLabelFormat = memoized(
  (timeZone) =>
    new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" }),
);
const timeFormat = memoized(
  (timeZone) => new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }),
);

/** Some ICU builds put U+202F (narrow no-break space) before AM/PM — normalize so
 *  output (and the tests pinning it) is byte-identical across Node/browser versions. */
const plainSpaces = (s: string) => s.replace(/\u202f/g, " ");

export type DayStripDay = {
  /** Stable per-day key in the practice timezone (YYYY-MM-DD). */
  readonly dayKey: string;
  /** "Mon" */
  readonly weekday: string;
  /** "6" */
  readonly dayOfMonth: string;
  /** e.g. "Monday, July 6" (accessible label). */
  readonly dayLabel: string;
  readonly slots: readonly AvailabilitySlot[];
};

const weekdayFormat = memoized(
  (timeZone) => new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }),
);
const dayOfMonthFormat = memoized(
  (timeZone) => new Intl.DateTimeFormat("en-US", { timeZone, day: "numeric" }),
);

/**
 * The booking window as a day strip (BOOKING_DESIGN.md §3): every practice-timezone
 * calendar day the window [start, start + days*24h] intersects, each carrying its
 * slots — including empty days, so fullness is honestly visible per day. The window
 * comes from the availability DTO, never a client clock, so no payload slot can fall
 * outside the strip. Walked in 6-hour steps: unlike +24h arithmetic, that can never
 * duplicate or skip a practice-timezone day across DST transitions (23h/25h days).
 */
export function dayStrip(
  slots: readonly AvailabilitySlot[],
  timezone: string,
  windowStartIso: string,
  windowDays: number,
): DayStripDay[] {
  const keyOf = dayKeyFormat(timezone);
  // Bucket slots per day, sorted once — dayParts relies on this order downstream.
  const buckets = new Map<string, AvailabilitySlot[]>();
  for (const slot of [...slots].sort((a, b) => a.start.localeCompare(b.start))) {
    const dayKey = keyOf.format(new Date(slot.start));
    const bucket = buckets.get(dayKey);
    if (bucket) {
      bucket.push(slot);
    } else {
      buckets.set(dayKey, [slot]);
    }
  }
  const startMs = Date.parse(windowStartIso);
  const endMs = startMs + windowDays * 24 * 60 * 60 * 1000;
  const STEP_MS = 6 * 60 * 60 * 1000;
  const days: DayStripDay[] = [];
  const seen = new Set<string>();
  for (let t = startMs; ; t += STEP_MS) {
    const clamped = Math.min(t, endMs);
    const date = new Date(clamped);
    const dayKey = keyOf.format(date);
    if (!seen.has(dayKey)) {
      seen.add(dayKey);
      days.push({
        dayKey,
        weekday: weekdayFormat(timezone).format(date),
        dayOfMonth: dayOfMonthFormat(timezone).format(date),
        dayLabel: dayLabelFormat(timezone).format(date),
        slots: buckets.get(dayKey) ?? [],
      });
    }
    if (clamped === endMs) {
      break;
    }
  }
  return days;
}

export type DayPart = {
  /** "Morning" | "Afternoon" | "Evening" */
  readonly label: string;
  readonly slots: readonly AvailabilitySlot[];
};

const hourFormat = memoized(
  (timeZone) => new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }),
);

/** One day's slots bucketed Morning (<12) / Afternoon (12–16) / Evening (17+), practice
 *  tz. Input arrives chronologically sorted (dayStrip buckets sort once). */
export function dayParts(slots: readonly AvailabilitySlot[], timezone: string): DayPart[] {
  const buckets: Record<string, AvailabilitySlot[]> = { Morning: [], Afternoon: [], Evening: [] };
  for (const slot of slots) {
    const hour = Number(hourFormat(timezone).format(new Date(slot.start)));
    const label = hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
    buckets[label]!.push(slot);
  }
  return Object.entries(buckets)
    .filter(([, s]) => s.length > 0)
    .map(([label, s]) => ({ label, slots: s }));
}

/** "2:30 PM" in the practice timezone. */
export function formatSlotTime(iso: string, timezone: string): string {
  return plainSpaces(timeFormat(timezone).format(new Date(iso)));
}

/** "Thursday, July 9 at 2:30 PM" — the confirmation's outcome statement. */
export function formatSlotFull(iso: string, timezone: string): string {
  const date = new Date(iso);
  return `${dayLabelFormat(timezone).format(date)} at ${plainSpaces(timeFormat(timezone).format(date))}`;
}

/** "$395" (whole dollars) or "$395.50". Price is catalog data — never enters FHIR. */
export function formatPrice(priceCents: number): string {
  const dollars = priceCents / 100;
  return priceCents % 100 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** "30 min" — durations are always minutes in the catalog. */
export function formatDuration(durationMinutes: number): string {
  return `${durationMinutes} min`;
}
