/**
 * Reading a date, and knowing a timezone — shared by the 4D adapter (every date column
 * it stages, and the zone its wall times are written in) and by the recovery CLIs (their
 * date and timezone flags).
 *
 * One validator, deliberately: a SHAPE check is not a validation. `2026-13-01` and
 * `2026-04-31` match a YYYY-MM-DD regex and are not dates, and a value that reaches
 * `Date.parse` as NaN does not fail loudly — it inverts every comparison it touches. So
 * the check is a round trip through a real calendar, and the caller gets the normalized
 * spelling back rather than the string it was handed.
 */

export const pad = (n: number): string => String(n).padStart(2, "0");

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/** A real calendar date rendered as "YYYY-MM-DD", or undefined if it is neither. */
export function calendarDate(value: string): string | undefined {
  const iso = ISO_DATE.exec(value);
  const us = iso ? null : US_DATE.exec(value);
  const parts = iso
    ? { year: iso[1]!, month: iso[2]!, day: iso[3]! }
    : us
      ? { year: us[3]!, month: us[1]!, day: us[2]! }
      : undefined;
  if (!parts) {
    return undefined;
  }
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const at = new Date(Date.UTC(year, month - 1, day));
  // Round-trip check: rejects month 13, February 30, and friends.
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    return undefined;
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Whether this runtime knows the IANA zone. Nothing here may fall back to UTC on a
 *  typo: the exports carry wall times with no offset, and the report dates instants as
 *  the local days they fell on, so the wrong zone moves both across days. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return true;
  } catch {
    return false;
  }
}
