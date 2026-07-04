/**
 * Minimal iCalendar builder for the confirmation screen's add-to-calendar affordance
 * (BOOKING_DESIGN.md §3 — calendar entry = built-in reminders, no vendor needed).
 * The file lands only on the patient's own device, at their explicit request.
 */

const icsDate = (iso: string): string =>
  new Date(iso)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

const escapeText = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

export function buildIcs(event: {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly start: string;
  readonly end: string;
  /** Creation stamp (injectable for tests). */
  readonly stamp: string;
}): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Medibun//Portal//EN",
    "BEGIN:VEVENT",
    `UID:${escapeText(event.id)}@medibun`,
    `DTSTAMP:${icsDate(event.stamp)}`,
    `DTSTART:${icsDate(event.start)}`,
    `DTEND:${icsDate(event.end)}`,
    `SUMMARY:${escapeText(event.title)}`,
    `DESCRIPTION:${escapeText(event.description)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

/** data: URL for a download link — no blob bookkeeping needed for a one-shot file. */
export function icsDataUrl(ics: string): string {
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;
}
