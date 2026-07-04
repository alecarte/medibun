import type { AppointmentStatus, DaySheetAppointment, ServiceColor } from "@medibun/api-client";

/**
 * Pure day-sheet logic: grid geometry, practice-timezone formatting, the status
 * workflow the UI may drive. All times render in the sheet's practice timezone —
 * never the device's (the front desk tablet and the BFF must agree on "today").
 */

/** One hour of calendar height, px. 30-minute blocks get two comfortable text lines. */
export const HOUR_PX = 112;

/** Forward moves the UI offers per status (undo is the toast's reverse write, not a
 *  menu item). Mirrors the BFF's transition graph — the server still enforces it. */
export const FORWARD_ACTIONS: Record<
  AppointmentStatus,
  readonly { to: AppointmentStatus; label: string }[]
> = {
  scheduled: [
    { to: "arrived", label: "Check in" },
    { to: "no-show", label: "Mark no-show" },
  ],
  arrived: [{ to: "roomed", label: "Room" }],
  roomed: [{ to: "completed", label: "Complete" }],
  completed: [],
  "no-show": [],
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

export const STATUS_LABEL: Record<AppointmentStatus, string> = {
  scheduled: "Scheduled",
  arrived: "Arrived",
  roomed: "Roomed",
  completed: "Completed",
  "no-show": "No-show",
};

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

/** Fractional hour-of-day of an instant in the practice timezone (e.g. 14.5). */
export function hourOf(iso: string, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return (Number(parts.hour) % 24) + Number(parts.minute) / 60;
}

/** The visible hour range: practice hours (9–17) stretched to fit every appointment. */
export function hourRange(
  appointments: readonly DaySheetAppointment[],
  timeZone: string,
): { startHour: number; endHour: number } {
  let startHour = 9;
  let endHour = 17;
  for (const appointment of appointments) {
    startHour = Math.min(startHour, Math.floor(hourOf(appointment.start, timeZone)));
    endHour = Math.max(endHour, Math.ceil(hourOf(appointment.end, timeZone)));
  }
  return { startHour, endHour };
}

/** A block's position inside its column, px from the grid top. */
export function blockGeometry(
  appointment: Pick<DaySheetAppointment, "start" | "end">,
  timeZone: string,
  startHour: number,
): { top: number; height: number } {
  const start = hourOf(appointment.start, timeZone);
  const end = hourOf(appointment.end, timeZone);
  return {
    top: (start - startHour) * HOUR_PX,
    // Never render a sliver: even a zero-length window stays clickable.
    height: Math.max((end - start) * HOUR_PX, 28),
  };
}

/** "2:00 PM" in the practice timezone. */
export function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** "9 AM" gutter label. */
export function formatHour(hour: number): string {
  const h = ((hour + 11) % 12) + 1;
  return `${h} ${hour < 12 ? "AM" : "PM"}`;
}

/** "Friday, July 4" from the sheet's practice-local date string (no timezone math —
 *  the BFF already resolved the practice-local day). */
export function formatDateHeading(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}
