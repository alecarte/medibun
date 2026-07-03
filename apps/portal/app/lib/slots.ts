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

const dayKeyFormat = (timezone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: timezone, dateStyle: "short" });
const dayLabelFormat = (timezone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
  });
const timeFormat = (timezone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" });

/** Slots bucketed per practice-timezone day, in chronological order. */
export function groupSlotsByDay(
  slots: readonly AvailabilitySlot[],
  timezone: string,
): DayGroup[] {
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
  return timeFormat(timezone).format(new Date(iso));
}

/** "Thursday, July 9 at 2:30 PM" — the confirmation's outcome statement. */
export function formatSlotFull(iso: string, timezone: string): string {
  const date = new Date(iso);
  return `${dayLabelFormat(timezone).format(date)} at ${timeFormat(timezone).format(date)}`;
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
