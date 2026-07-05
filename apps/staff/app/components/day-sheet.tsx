"use client";

import {
  createApiClient,
  StaffError,
  type AppointmentStatus,
  type DaySheet,
  type DaySheetAppointment,
} from "@medibun/api-client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  ACTION_DONE,
  blockGeometry,
  CATEGORY_EDGE,
  formatTime,
  formatHour,
  FORWARD_ACTIONS,
  HOUR_PX,
  hourOf,
  hourRange,
  STATUS_CHIP,
  STATUS_LABEL,
} from "../lib/day-sheet";

/**
 * The schedule day sheet: one column per practitioner, every appointment at once
 * (V0_PROPOSAL S5 spec). Quiet-tool register; keyboard-first (arrows move, Enter opens
 * details, C checks in, Z undoes); check-in is undo-over-confirm — the write happens
 * immediately and a ~10s toast offers the compensating reverse (DESIGN.md tenet 4).
 */

const UNDO_WINDOW_MS = 10_000;

type Undo = {
  readonly appointmentId: string;
  readonly from: AppointmentStatus;
  readonly to: AppointmentStatus;
  readonly patientName: string;
  readonly expiresAt: number;
};

/** Status chip (color + dot + label — never color alone). `compact` slims the vertical
 *  padding so the chip fits a 30-minute block's time row without clipping. */
function StatusChip({ status, compact }: { status: AppointmentStatus; compact?: boolean }) {
  return (
    <span className={`status-chip ${STATUS_CHIP[status]} ${compact ? "shrink-0 py-0" : ""}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function DetailRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <dt className="text-xs text-text-secondary">{label}</dt>
      <dd className="min-w-0 truncate text-sm text-text-primary tabular-nums">{value ?? "—"}</dd>
    </div>
  );
}

export function DaySheetView({ sheet }: { sheet: DaySheet }) {
  const router = useRouter();
  const api = useMemo(() => createApiClient({ baseUrl: "/api" }), []);
  const tz = sheet.timezone;

  // Optimistic status per appointment; a refreshed sheet (server truth) resets it.
  const [statuses, setStatuses] = useState<Record<string, AppointmentStatus>>({});
  useEffect(() => {
    setStatuses(Object.fromEntries(sheet.appointments.map((a) => [a.id, a.status])));
  }, [sheet]);

  const [focusedId, setFocusedId] = useState<string | undefined>();
  const [detailId, setDetailId] = useState<string | undefined>();
  const [undo, setUndo] = useState<Undo | undefined>();
  const [undoSecondsLeft, setUndoSecondsLeft] = useState(0);
  const [notice, setNotice] = useState<string | undefined>();
  const [nowTick, setNowTick] = useState<number | undefined>(); // set after mount (hydration-safe)

  const blockRefs = useRef(new Map<string, HTMLButtonElement>());
  const dialogRef = useRef<HTMLDivElement>(null);

  const { startHour, endHour } = hourRange(sheet.appointments, tz);
  const gridHeight = (endHour - startHour) * HOUR_PX;
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);

  const byColumn = useMemo(() => {
    const map = new Map<string, DaySheetAppointment[]>();
    for (const p of sheet.practitioners) {
      map.set(p.practitionerId, []);
    }
    for (const a of sheet.appointments) {
      map.get(a.practitionerId)?.push(a);
    }
    for (const list of map.values()) {
      list.sort((x, y) => x.start.localeCompare(y.start));
    }
    return map;
  }, [sheet]);

  const appointmentById = useMemo(() => new Map(sheet.appointments.map((a) => [a.id, a])), [sheet]);

  // The now line ticks every minute; rendered only after mount so SSR/CSR HTML match.
  useEffect(() => {
    setNowTick(Date.now());
    const interval = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  // Undo countdown → the toast expires itself.
  useEffect(() => {
    if (!undo) {
      return;
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((undo.expiresAt - Date.now()) / 1000));
      setUndoSecondsLeft(left);
      if (left === 0) {
        setUndo(undefined);
      }
    };
    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [undo]);

  // Notices fade on their own; the live region has already announced them.
  useEffect(() => {
    if (!notice) {
      return;
    }
    const timeout = setTimeout(() => setNotice(undefined), 6000);
    return () => clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (detailId) {
      dialogRef.current?.focus();
    }
  }, [detailId]);

  async function writeStatus(
    appointment: DaySheetAppointment,
    from: AppointmentStatus,
    to: AppointmentStatus,
    withUndo: boolean,
  ) {
    setStatuses((s) => ({ ...s, [appointment.id]: to }));
    setDetailId(undefined);
    try {
      await api.setAppointmentStatus(appointment.id, to);
      if (withUndo) {
        setUndo({
          appointmentId: appointment.id,
          from,
          to,
          patientName: appointment.patientName,
          expiresAt: Date.now() + UNDO_WINDOW_MS,
        });
      }
    } catch (err) {
      setStatuses((s) => ({ ...s, [appointment.id]: from }));
      if (err instanceof StaffError && err.code === "conflict") {
        // Another station moved it first — pull truth instead of arguing.
        setNotice("That appointment changed on another station. Refreshing the sheet.");
        router.refresh();
      } else {
        setNotice("Couldn't update the appointment. Try again.");
      }
    }
  }

  function act(appointment: DaySheetAppointment, to: AppointmentStatus) {
    const from = statuses[appointment.id];
    if (!from || from === to) {
      return;
    }
    void writeStatus(appointment, from, to, true);
  }

  function undoNow() {
    if (!undo) {
      return;
    }
    const appointment = appointmentById.get(undo.appointmentId);
    setUndo(undefined);
    if (appointment) {
      // The compensating reverse write — no undo toast for an undo.
      void writeStatus(appointment, undo.to, undo.from, false);
    }
  }

  function moveFocus(current: DaySheetAppointment, key: string) {
    const column = byColumn.get(current.practitionerId) ?? [];
    const index = column.findIndex((a) => a.id === current.id);
    let target: DaySheetAppointment | undefined;
    if (key === "ArrowDown") {
      target = column[index + 1];
    } else if (key === "ArrowUp") {
      target = column[index - 1];
    } else {
      const order = sheet.practitioners.map((p) => p.practitionerId);
      const columnIndex = order.indexOf(current.practitionerId);
      const nextColumn = order[columnIndex + (key === "ArrowRight" ? 1 : -1)];
      const candidates = nextColumn ? (byColumn.get(nextColumn) ?? []) : [];
      // Nearest by start time keeps left/right feeling like "same moment, next room".
      target = [...candidates].sort(
        (x, y) =>
          Math.abs(Date.parse(x.start) - Date.parse(current.start)) -
          Math.abs(Date.parse(y.start) - Date.parse(current.start)),
      )[0];
    }
    if (target) {
      setFocusedId(target.id);
      blockRefs.current.get(target.id)?.focus();
    }
  }

  function onGridKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      setDetailId(undefined);
      return;
    }
    if (event.key.toLowerCase() === "z" && undo) {
      event.preventDefault();
      undoNow();
      return;
    }
    const current = focusedId ? appointmentById.get(focusedId) : undefined;
    if (!current) {
      return;
    }
    if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      moveFocus(current, event.key);
      return;
    }
    if (event.key.toLowerCase() === "c" && statuses[current.id] === "scheduled") {
      event.preventDefault();
      act(current, "arrived");
    }
  }

  const detail = detailId ? appointmentById.get(detailId) : undefined;
  const detailStatus = detail ? statuses[detail.id] : undefined;
  const nowHour = nowTick === undefined ? undefined : hourOf(new Date(nowTick).toISOString(), tz);
  const nowTop =
    nowHour !== undefined && nowHour >= startHour && nowHour <= endHour
      ? (nowHour - startHour) * HOUR_PX
      : undefined;
  const firstFocusableId = sheet.appointments[0]?.id;

  return (
    <section
      aria-label="Day sheet"
      className="rounded-lg border border-border-hairline bg-surface-card"
    >
      {/* One persistent live region — visible when it has something to say. Names only
          (data the signed-in staff member already sees on this screen), never more. */}
      <p
        aria-live="polite"
        role="status"
        className={
          notice
            ? "border-b border-border-hairline px-5 py-2 text-sm text-status-warning-text"
            : "sr-only"
        }
      >
        {notice}
      </p>

      <div className="overflow-x-auto" onKeyDown={onGridKeyDown}>
        <div className="min-w-fit">
          {/* Column headers */}
          <div className="flex border-b border-border-hairline">
            <div className="w-14 shrink-0" aria-hidden />
            {sheet.practitioners.map((p) => (
              <div
                key={p.practitionerId}
                className="min-w-56 flex-1 border-l border-border-hairline px-3 py-2.5"
              >
                <span className="text-sm font-medium text-text-primary">{p.practitionerName}</span>
              </div>
            ))}
          </div>

          {/* Grid */}
          <div className="relative flex" style={{ height: gridHeight }}>
            {/* Hour gutter + lines */}
            <div className="relative w-14 shrink-0" aria-hidden>
              {hours.map((hour) => (
                <span
                  key={hour}
                  className="absolute right-2 -translate-y-1/2 text-[11px] text-text-secondary tabular-nums"
                  style={{ top: (hour - startHour) * HOUR_PX }}
                >
                  {formatHour(hour)}
                </span>
              ))}
            </div>
            <div className="pointer-events-none absolute inset-y-0 right-0 left-14" aria-hidden>
              {hours.slice(1).map((hour) => (
                <div
                  key={hour}
                  className="absolute right-0 left-0 border-t border-border-hairline"
                  style={{ top: (hour - startHour) * HOUR_PX }}
                />
              ))}
              {nowTop !== undefined && (
                <div
                  data-testid="now-line"
                  className="absolute right-0 left-0 border-t-2 border-brand-primary opacity-60"
                  style={{ top: nowTop }}
                />
              )}
            </div>

            {/* Practitioner columns */}
            {sheet.practitioners.map((p) => (
              <div
                key={p.practitionerId}
                role="list"
                aria-label={`${p.practitionerName} appointments`}
                className="relative min-w-56 flex-1 border-l border-border-hairline"
              >
                {(byColumn.get(p.practitionerId) ?? []).map((a) => {
                  const status = statuses[a.id] ?? a.status;
                  const { top, height } = blockGeometry(a, tz, startHour);
                  const edge = a.serviceColor
                    ? CATEGORY_EDGE[a.serviceColor]
                    : "border-l-border-interactive";
                  return (
                    <div
                      key={a.id}
                      role="listitem"
                      className="absolute right-1.5 left-1.5"
                      style={{ top, height }}
                    >
                      <button
                        type="button"
                        ref={(el) => {
                          if (el) {
                            blockRefs.current.set(a.id, el);
                          } else {
                            blockRefs.current.delete(a.id);
                          }
                        }}
                        tabIndex={a.id === (focusedId ?? firstFocusableId) ? 0 : -1}
                        onFocus={() => setFocusedId(a.id)}
                        onClick={() => setDetailId(a.id === detailId ? undefined : a.id)}
                        aria-haspopup="dialog"
                        aria-expanded={detailId === a.id}
                        className={`block h-full w-full overflow-hidden rounded-md border border-border-hairline border-l-4 bg-surface-card px-2 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-action-primary ${edge} ${
                          status === "completed" || status === "no-show" ? "opacity-70" : ""
                        }`}
                      >
                        {/* Chip rides the time row so 30-minute blocks never clip it. */}
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate text-[11px] text-text-secondary tabular-nums">
                            {formatTime(a.start, tz)}–{formatTime(a.end, tz)}
                          </span>
                          <StatusChip status={status} compact />
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[13px] font-medium text-text-primary">
                            {a.patientName}
                          </span>
                          {a.firstVisit && (
                            <span className="shrink-0 rounded-full bg-brand-wash px-1.5 text-[10px] font-medium text-brand-primary">
                              New
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 block truncate pr-16 text-[11px] text-text-secondary">
                          {a.serviceName ?? "Appointment"}
                        </span>
                      </button>
                      {status === "scheduled" && (
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label={`Check in ${a.patientName}`}
                          onClick={() => act(a, "arrived")}
                          className="absolute right-1 bottom-1 rounded-control bg-action-primary px-2 py-0.5 text-[11px] font-medium text-text-on-accent"
                        >
                          Check in
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}

            {sheet.appointments.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="text-center">
                  <p className="text-sm font-medium text-text-primary">
                    No appointments on this day.
                  </p>
                  <p className="mt-1 text-sm text-text-secondary">
                    Portal bookings appear here as they land.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Keyboard hints — the staff app is keyboard-first (DESIGN.md tenet 4). */}
      <p className="hidden border-t border-border-hairline px-5 py-2 text-xs text-text-secondary md:block">
        ↑↓←→ move · Enter details · C check in · Z undo
      </p>

      {/* Detail card (fixed, never clipped by the scroll container; tablet-friendly). */}
      {detail && detailStatus && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-label={`Appointment details — ${detail.patientName}`}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setDetailId(undefined);
              blockRefs.current.get(detail.id)?.focus();
            }
          }}
          className="fixed inset-x-4 bottom-4 z-40 rounded-lg border border-border-hairline bg-surface-card p-4 shadow-lg outline-none md:inset-x-auto md:right-6 md:bottom-6 md:w-96"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
                <span className="truncate">{detail.patientName}</span>
                {detail.firstVisit && (
                  <span className="shrink-0 rounded-full bg-brand-wash px-1.5 text-[10px] font-medium text-brand-primary">
                    New
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-xs text-text-secondary">
                {detail.serviceName ?? "Appointment"} · {formatTime(detail.start, tz)}–
                {formatTime(detail.end, tz)}
              </p>
            </div>
            <StatusChip status={detailStatus} />
          </div>
          <dl className="mt-3 border-t border-border-hairline pt-2">
            <DetailRow label="Phone" value={detail.patientPhone} />
            <DetailRow label="Email" value={detail.patientEmail} />
            <DetailRow
              label="Booked"
              value={
                detail.bookedAt
                  ? new Intl.DateTimeFormat("en-US", {
                      timeZone: tz,
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    }).format(new Date(detail.bookedAt))
                  : undefined
              }
            />
          </dl>
          <div className="mt-3 flex items-center justify-between gap-2">
            <div className="flex gap-2">
              {FORWARD_ACTIONS[detailStatus].map(({ to, label }, index) => (
                <button
                  key={to}
                  type="button"
                  onClick={() => act(detail, to)}
                  className={
                    index === 0
                      ? "rounded-control bg-action-primary px-3 py-1.5 text-sm font-medium text-text-on-accent"
                      : "rounded-control border border-border-interactive px-3 py-1.5 text-sm text-text-primary"
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                setDetailId(undefined);
                blockRefs.current.get(detail.id)?.focus();
              }}
              className="rounded-control px-3 py-1.5 text-sm text-text-secondary"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Undo toast: the action already happened; this is the take-back window. */}
      {undo && (
        <div
          role="status"
          className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-border-hairline bg-surface-card px-4 py-2.5 shadow-lg"
        >
          <span className="text-sm text-text-primary">
            {ACTION_DONE[undo.to]} — {undo.patientName}
          </span>
          <button
            type="button"
            onClick={undoNow}
            className="rounded-control border border-border-interactive px-3 py-1 text-sm font-medium text-text-primary"
          >
            Undo ({undoSecondsLeft}s)
          </button>
        </div>
      )}
    </section>
  );
}
