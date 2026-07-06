import {
  FORWARD_TRANSITIONS,
  weekStart,
  type AppointmentStatus,
  type DaySheetAppointment,
  type InternalEvent,
  type InternalEventType,
  type ServiceColor,
} from "@medibun/api-client";

// Shared calendar math (also the BFF's week-snap authority) — re-exported so every
// staff-app consumer keeps importing calendar helpers from this one module.
export { weekStart };

/**
 * Pure day-sheet logic: grid geometry, practice-timezone formatting, the status
 * workflow the UI may drive. All times render in the sheet's practice timezone —
 * never the device's (the front desk tablet and the BFF must agree on "today").
 */

/** One hour of calendar height, px. 30-minute blocks get two comfortable text lines. */
export const HOUR_PX = 112;

/** The full grid spans the whole day (00:00–24:00, Google-Calendar model). */
export const DAY_START_HOUR = 0;
export const DAY_END_HOUR = 24;

/** The schedule views. Month is reserved (SCHEDULE_DESIGN.md) — dropdown-only for now. */
export type ScheduleView = "day" | "week";

/** Days each view fetches/renders. */
export const VIEW_DAYS: Record<ScheduleView, number> = { day: 1, week: 7 };

/** Pure YYYY-MM-DD calendar math (no timezone — these are practice-local date labels). */
export function shiftYmd(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** The practice-local YYYY-MM-DD of an instant (for bucketing appointments into days). */
export function ymdOf(iso: string, timeZone: string): string {
  return cachedFormatter("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** N consecutive YYYY-MM-DD dates from `start`. */
export function daySpan(start: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => shiftYmd(start, i));
}

/** UI copy per forward target (undo is the toast's reverse write, not a menu item). */
const ACTION_LABEL: Partial<Record<AppointmentStatus, string>> = {
  arrived: "Check in",
  "no-show": "Mark no-show",
  roomed: "Room",
  completed: "Complete",
};

const actionsFor = (status: AppointmentStatus): readonly Action[] =>
  FORWARD_TRANSITIONS[status].map((to) => ({ to, label: ACTION_LABEL[to]! }));

type Action = { readonly to: AppointmentStatus; readonly label: string };

/** Forward moves the UI offers per status — built ON the shared transition graph
 *  (@medibun/api-client), so the menu and the BFF's enforcement can never drift. */
export const FORWARD_ACTIONS: Record<AppointmentStatus, readonly Action[]> = {
  scheduled: actionsFor("scheduled"),
  arrived: actionsFor("arrived"),
  roomed: actionsFor("roomed"),
  completed: actionsFor("completed"),
  "no-show": actionsFor("no-show"),
};

/** Chip styling per status: wash + text (+ the ::before dot via currentColor). Written
 *  out literally so Tailwind's scanner sees every class. Roomed rides the brand wash —
 *  the one in-progress state earns the accent (DESIGN.md: accent = active). */
export const STATUS_CHIP: Record<AppointmentStatus, string> = {
  scheduled: "bg-status-info-wash text-status-info-text",
  arrived: "bg-status-success-wash text-status-success-text",
  roomed: "bg-brand-wash text-brand-primary",
  completed: "bg-surface-well text-text-secondary",
  "no-show": "bg-status-danger-wash text-status-danger-text",
};

/** Solid dot color per status for the compact (week-view) block, where a full chip is
 *  too wide. Literal classes for the Tailwind scanner. */
export const STATUS_DOT: Record<AppointmentStatus, string> = {
  scheduled: "bg-status-info-text",
  arrived: "bg-status-success-text",
  roomed: "bg-brand-primary",
  completed: "bg-text-secondary",
  "no-show": "bg-status-danger-text",
};

export const STATUS_LABEL: Record<AppointmentStatus, string> = {
  scheduled: "Scheduled",
  arrived: "Arrived",
  roomed: "Roomed",
  completed: "Completed",
  "no-show": "No-show",
};

/** Display label per internal-event type (S5c). Time off is not a type — it's a
 *  titled block ("PTO"), all-day or partial (amendment, Alec 2026-07-06). */
export const EVENT_TYPE_LABEL: Record<InternalEventType, string> = {
  meeting: "Meeting",
  block: "Blocked time",
};

/** Whether an event's window is a whole practice-local day (both edges at local
 *  midnight) — how "all day" reads back off the wire, DST-proof (23/24/25h all work). */
export function isAllDayEvent(
  event: Pick<InternalEvent, "start" | "end">,
  timeZone: string,
): boolean {
  return (
    event.end > event.start &&
    wallTime(event.start, timeZone) === "00:00" &&
    wallTime(event.end, timeZone) === "00:00"
  );
}

/** Confirmation line for the undo toast (voice: states the outcome, never celebrates). */
export const ACTION_DONE: Record<AppointmentStatus, string> = {
  scheduled: "Moved back to scheduled",
  arrived: "Checked in",
  roomed: "Roomed",
  completed: "Completed",
  "no-show": "Marked no-show",
};

/** Service accent on the block's left edge — literal classes for the scanner. */
export const CATEGORY_EDGE: Record<ServiceColor, string> = {
  sage: "border-l-category-sage-text",
  teal: "border-l-category-teal-text",
  indigo: "border-l-category-indigo-text",
  plum: "border-l-category-plum-text",
  clay: "border-l-category-clay-text",
  slate: "border-l-category-slate-text",
};

/** Cached Intl formatters — constructing one per call is expensive and the grid
 *  formats hundreds of instants per render. Keyed by locale + options. */
const formatterCache = new Map<string, Intl.DateTimeFormat>();
function cachedFormatter(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(opts)}`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, opts);
    formatterCache.set(key, formatter);
  }
  return formatter;
}

/** Newer ICU separates time from AM/PM with U+202F (narrow no-break space); normalize
 *  to a plain space so rendered copy — and tests — agree across runtimes. */
const normalizeSpaces = (value: string): string => value.replace(/\u202f/g, " ");

/** Fractional hour-of-day of an instant in the practice timezone (e.g. 14.5). */
export function hourOf(iso: string, timeZone: string): number {
  const parts = Object.fromEntries(
    cachedFormatter("en-US", { timeZone, hour12: false, hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return (Number(parts.hour) % 24) + Number(parts.minute) / 60;
}

/** A block's position inside its column, px from the grid top. */
export function blockGeometry(
  appointment: Pick<DaySheetAppointment, "start" | "end">,
  timeZone: string,
  startHour: number,
): { top: number; height: number } {
  const start = hourOf(appointment.start, timeZone);
  // Height comes from the REAL duration, not end-hour minus start-hour: an all-day
  // window (day off) ends at next-midnight, where hourOf is 0 again and a subtraction
  // collapses the block to a sliver. Clamped to the grid so a DST 25h day can't overflow.
  const durationHours = (Date.parse(appointment.end) - Date.parse(appointment.start)) / 3600_000;
  const clamped = Math.min(durationHours, DAY_END_HOUR - start);
  return {
    top: (start - startHour) * HOUR_PX,
    // Never render a sliver: even a zero-length window stays clickable.
    height: Math.max(clamped * HOUR_PX, 28),
  };
}

/** "14:30" — the practice-local wall time of an instant, in the 24h form the BFF's
 *  event contract expects (undo-recreate sends an event back as wall times). */
export function wallTime(iso: string, timeZone: string): string {
  const parts = Object.fromEntries(
    cachedFormatter("en-US", { timeZone, hour12: false, hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${String(Number(parts.hour) % 24).padStart(2, "0")}:${parts.minute}`;
}

/** "2:00 PM" in the practice timezone. */
export function formatTime(iso: string, timeZone: string): string {
  return normalizeSpaces(
    cachedFormatter("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(
      new Date(iso),
    ),
  );
}

/** "Jul 1, 3:00 PM" booked-at line (detail card) in the practice timezone. */
export function formatBookedAt(iso: string, timeZone: string): string {
  return normalizeSpaces(
    cachedFormatter("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso)),
  );
}

/** "9 AM" gutter label. */
export function formatHour(hour: number): string {
  const h = ((hour + 11) % 12) + 1;
  return `${h} ${hour < 12 ? "AM" : "PM"}`;
}

/** A YYYY-MM-DD date as a UTC-noon Date, safe for Intl formatting (no tz drift). */
function ymdToDate(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12));
}

const fmt = (date: string, opts: Intl.DateTimeFormatOptions): string =>
  cachedFormatter("en-US", { timeZone: "UTC", ...opts }).format(ymdToDate(date));

/** Toolbar date-button label: "Mon, Jul 6" (day) or "Jul 6 – 12" / "Jun 29 – Jul 5"
 *  (week — collapses the month when both ends share one). */
export function formatToolbarDate(start: string, days: number): string {
  if (days <= 1) {
    return fmt(start, { weekday: "short", month: "short", day: "numeric" });
  }
  const end = shiftYmd(start, days - 1);
  const left = fmt(start, { month: "short", day: "numeric" });
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  const right = fmt(end, sameMonth ? { day: "numeric" } : { month: "short", day: "numeric" });
  return `${left} – ${right}`;
}

/** Short weekday + day-of-month for a week column header ("Mon 6"). */
export function formatColumnDay(date: string): { weekday: string; day: string } {
  return { weekday: fmt(date, { weekday: "short" }), day: fmt(date, { day: "numeric" }) };
}

/** "July 2026" month/year label for the mini-calendar header. */
export function formatMonthYear(date: string): string {
  return fmt(date, { month: "long", year: "numeric" });
}

/**
 * The 6-week (42-cell) grid for a month containing `anchor` (YYYY-MM-DD), Monday-first.
 * Each cell carries its YYYY-MM-DD and whether it belongs to the anchor's month. Stable
 * 6-row height keeps the popover from resizing as months change.
 */
export function monthGrid(anchor: string): { date: string; inMonth: boolean }[] {
  const month = anchor.slice(0, 7);
  const first = `${month}-01`;
  const gridStart = weekStart(first);
  return Array.from({ length: 42 }, (_, i) => {
    const date = shiftYmd(gridStart, i);
    return { date, inMonth: date.slice(0, 7) === month };
  });
}
