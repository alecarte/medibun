import type { AvailabilitySlot } from "@medibun/api-client";

/**
 * Slot/price presentation helpers. All times render in the PRACTICE timezone (the
 * practitioner's IANA zone from the availability DTO) — a visit happens at the studio,
 * not in the browser's zone. Numbers are always tabular (DESIGN.md).
 */

export type DayGroup = {
  /** Stable per-day key in the practice timezone (YYYY-MM-DD). */
  readonly dayKey: string;
  /** e.g. "Thursday, July 9" */
  readonly dayLabel: string;
  readonly slots: readonly AvailabilitySlot[];
};

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

/** Slots bucketed per practice-timezone day, in chronological order. */
export function groupSlotsByDay(slots: readonly AvailabilitySlot[], timezone: string): DayGroup[] {
  const keyOf = dayKeyFormat(timezone);
  const labelOf = dayLabelFormat(timezone);
  const groups = new Map<string, { dayLabel: string; slots: AvailabilitySlot[] }>();
  for (const slot of [...slots].sort((a, b) => a.start.localeCompare(b.start))) {
    const date = new Date(slot.start);
    const dayKey = keyOf.format(date);
    const group = groups.get(dayKey) ?? { dayLabel: labelOf.format(date), slots: [] };
    group.slots.push(slot);
    groups.set(dayKey, group);
  }
  return [...groups.entries()].map(([dayKey, group]) => ({ dayKey, ...group }));
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
