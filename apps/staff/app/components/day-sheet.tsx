"use client";

import {
  createApiClient,
  StaffError,
  type AppointmentStatus,
  type DaySheet,
  type DaySheetAppointment,
} from "@medibun/api-client";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  ACTION_DONE,
  blockGeometry,
  CATEGORY_EDGE,
  daySpan,
  DAY_END_HOUR,
  DAY_START_HOUR,
  formatColumnDay,
  formatHour,
  formatTime,
  formatToolbarDate,
  FORWARD_ACTIONS,
  HOUR_PX,
  hourOf,
  shiftYmd,
  STATUS_CHIP,
  STATUS_DOT,
  STATUS_LABEL,
  VIEW_DAYS,
  weekStart,
  ymdOf,
  type ScheduleView,
} from "../lib/day-sheet";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, KeyboardIcon } from "./icons";
import { MiniCalendar } from "./mini-calendar";
import { Popover } from "./popover";
import { ShortcutsPopover } from "./shortcuts";
import { Tooltip } from "./tooltip";

/**
 * The Schedule surface (SCHEDULE_DESIGN.md): a viewport-fit calendar card whose 24-hour
 * grid scrolls internally under a sticky header + time gutter, a toolbar (period nav +
 * date picker + view switch + practitioner filter + shortcuts), and the S5 status
 * workflow (one-tap check-in, ~10s compensating undo, detail card). Day view = one
 * column per practitioner; week view = Mon–Sun for one practitioner. Navigation is URL
 * state (RSC refetch); the practitioner filter switches client-side over the fetched week.
 */

const UNDO_WINDOW_MS = 10_000;
const GRID_HEIGHT = (DAY_END_HOUR - DAY_START_HOUR) * HOUR_PX;

type Undo = {
  readonly appointmentId: string;
  readonly from: AppointmentStatus;
  readonly to: AppointmentStatus;
  readonly patientName: string;
  readonly expiresAt: number;
};

/** A rendered column: practitioners (day view) or weekdays (week view). */
type Column = {
  readonly key: string;
  readonly appointments: DaySheetAppointment[];
  readonly header: React.ReactNode;
};

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

export function ScheduleView({
  sheet,
  view,
  practitionerId,
  selfPractitionerId,
}: {
  sheet: DaySheet;
  view: ScheduleView;
  /** Week-view practitioner filter from the URL; undefined → default. */
  practitionerId?: string;
  /** The signed-in practitioner, the week filter's default target when present. */
  selfPractitionerId?: string;
}) {
  const router = useRouter();
  const api = useMemo(() => createApiClient({ baseUrl: "/api" }), []);
  const tz = sheet.timezone;
  const isWeek = view === "week";

  // Optimistic status per appointment; a refreshed sheet (server truth) resets it.
  const [statuses, setStatuses] = useState<Record<string, AppointmentStatus>>({});
  useEffect(() => {
    setStatuses(Object.fromEntries(sheet.appointments.map((a) => [a.id, a.status])));
  }, [sheet]);

  // Default the week filter to the signed-in practitioner (if they have appointments/a
  // column here), else the first practitioner. URL param wins when valid.
  const practitionerIds = useMemo(() => sheet.practitioners.map((p) => p.practitionerId), [sheet]);
  const defaultPractitioner =
    (selfPractitionerId && practitionerIds.includes(selfPractitionerId)
      ? selfPractitionerId
      : undefined) ?? practitionerIds[0];
  const [selectedPractitioner, setSelectedPractitioner] = useState<string | undefined>(
    practitionerId && practitionerIds.includes(practitionerId)
      ? practitionerId
      : defaultPractitioner,
  );
  useEffect(() => {
    setSelectedPractitioner(
      practitionerId && practitionerIds.includes(practitionerId)
        ? practitionerId
        : defaultPractitioner,
    );
  }, [practitionerId, defaultPractitioner, practitionerIds]);

  const [focusedId, setFocusedId] = useState<string | undefined>();
  const [detailId, setDetailId] = useState<string | undefined>();
  const [undo, setUndo] = useState<Undo | undefined>();
  const [undoSecondsLeft, setUndoSecondsLeft] = useState(0);
  const [notice, setNotice] = useState<string | undefined>();
  const [nowMs, setNowMs] = useState<number | undefined>(); // client clock, set after mount

  const blockRefs = useRef(new Map<string, HTMLButtonElement>());
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ---- Columns ---------------------------------------------------------------
  const columns: Column[] = useMemo(() => {
    if (isWeek) {
      const mine = sheet.appointments.filter((a) => a.practitionerId === selectedPractitioner);
      return daySpan(sheet.date, sheet.days).map((ymd) => {
        const { weekday, day } = formatColumnDay(ymd);
        return {
          key: ymd,
          appointments: mine.filter((a) => ymdOf(a.start, tz) === ymd),
          header: (
            <span className="flex items-baseline gap-1.5">
              <span className="text-sm font-medium text-text-primary">{weekday}</span>
              <span className="text-sm text-text-secondary tabular-nums">{day}</span>
            </span>
          ),
        };
      });
    }
    return sheet.practitioners.map((p) => ({
      key: p.practitionerId,
      appointments: sheet.appointments.filter((a) => a.practitionerId === p.practitionerId),
      header: <span className="text-sm font-medium text-text-primary">{p.practitionerName}</span>,
    }));
  }, [sheet, isWeek, selectedPractitioner, tz]);

  const appointmentById = useMemo(() => new Map(sheet.appointments.map((a) => [a.id, a])), [sheet]);
  const visibleAppointments = useMemo(() => columns.flatMap((c) => c.appointments), [columns]);
  const firstFocusableId = columns.find((c) => c.appointments.length > 0)?.appointments[0]?.id;

  // ---- Clock + auto-scroll ---------------------------------------------------
  useEffect(() => {
    setNowMs(Date.now());
    const interval = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  const days = daySpan(sheet.date, sheet.days);
  const nowYmd = nowMs === undefined ? undefined : ymdOf(new Date(nowMs).toISOString(), tz);
  const nowInView = nowYmd !== undefined && days.includes(nowYmd);
  const nowHour = nowMs === undefined ? undefined : hourOf(new Date(nowMs).toISOString(), tz);

  // Scroll to ~1h before now (today in view) or the first appointment, once per view of
  // the sheet. Reads the clock directly (not the ticking state) so a minute tick never
  // yanks the scroll back — the deps are the sheet/view/filter identity only.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const spanDays = daySpan(sheet.date, sheet.days);
    const todayNow = new Date();
    const todayInView = spanDays.includes(ymdOf(todayNow.toISOString(), tz));
    let targetHour: number | undefined;
    if (todayInView) {
      targetHour = Math.max(DAY_START_HOUR, hourOf(todayNow.toISOString(), tz) - 1);
    } else if (visibleAppointments.length > 0) {
      targetHour = Math.min(...visibleAppointments.map((a) => hourOf(a.start, tz))) - 0.5;
    }
    if (targetHour !== undefined) {
      el.scrollTop = Math.max(0, (targetHour - DAY_START_HOUR) * HOUR_PX);
    }
  }, [sheet, tz, view, selectedPractitioner, visibleAppointments]);

  // ---- Undo + notice timers --------------------------------------------------
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

  // ---- Status writes ---------------------------------------------------------
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
        setNotice("That appointment changed on another station. Refreshing the schedule.");
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
      void writeStatus(appointment, undo.to, undo.from, false);
    }
  }

  // ---- Navigation (URL is the state) -----------------------------------------
  function hrefFor(next: { view?: ScheduleView; date?: string | null; practitioner?: string }) {
    const params = new URLSearchParams();
    const v = next.view ?? view;
    if (v !== "day") {
      params.set("view", v);
    }
    // `date: null` means "clear" (jump to today); undefined means "keep current".
    const date = next.date === undefined ? sheet.date : next.date;
    if (date) {
      params.set("date", date);
    }
    const p = next.practitioner ?? (v === "week" ? selectedPractitioner : undefined);
    if (v === "week" && p) {
      params.set("practitioner", p);
    }
    const qs = params.toString();
    return qs ? `/schedule?${qs}` : "/schedule";
  }

  const go = (next: Parameters<typeof hrefFor>[0]) => router.push(hrefFor(next));
  const period = VIEW_DAYS[view];
  const goPrev = () => go({ date: shiftYmd(sheet.date, -period) });
  const goNext = () => go({ date: shiftYmd(sheet.date, period) });
  const goToday = () => go({ date: null });
  const setView = (v: ScheduleView) =>
    go({ view: v, date: v === "week" ? weekStart(sheet.date) : sheet.date });

  function pickDate(date: string) {
    go({ date: view === "week" ? weekStart(date) : date });
  }

  function selectPractitioner(id: string) {
    setSelectedPractitioner(id);
    // Reflect to the URL for shareability WITHOUT a refetch (data already covers the week).
    window.history.replaceState(null, "", hrefFor({ practitioner: id }));
  }

  // ---- Keyboard --------------------------------------------------------------
  function moveFocus(current: DaySheetAppointment, key: string) {
    const colIndex = columns.findIndex((c) => c.appointments.some((a) => a.id === current.id));
    const column = columns[colIndex]?.appointments ?? [];
    const rowIndex = column.findIndex((a) => a.id === current.id);
    let target: DaySheetAppointment | undefined;
    if (key === "ArrowDown") {
      target = column[rowIndex + 1];
    } else if (key === "ArrowUp") {
      target = column[rowIndex - 1];
    } else {
      const nextCol = columns[colIndex + (key === "ArrowRight" ? 1 : -1)];
      // Nearest by start time — "same moment, next column".
      target = [...(nextCol?.appointments ?? [])].sort(
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")
      ) {
        return;
      }
      switch (event.key.toLowerCase()) {
        case "t":
          event.preventDefault();
          goToday();
          break;
        case "[":
          event.preventDefault();
          goPrev();
          break;
        case "]":
          event.preventDefault();
          goNext();
          break;
        case "d":
          event.preventDefault();
          if (isWeek) setView("day");
          break;
        case "w":
          event.preventDefault();
          if (!isWeek) setView("week");
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

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
  const hours = Array.from({ length: DAY_END_HOUR - DAY_START_HOUR }, (_, i) => DAY_START_HOUR + i);
  const nowTop =
    nowInView && nowHour !== undefined ? (nowHour - DAY_START_HOUR) * HOUR_PX : undefined;

  const selectedName = sheet.practitioners.find(
    (p) => p.practitionerId === selectedPractitioner,
  )?.practitionerName;

  return (
    <section
      aria-label="Schedule"
      className="flex min-h-0 flex-1 flex-col rounded-lg border border-border-hairline bg-surface-card"
    >
      {/* ---- Toolbar ---- */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border-hairline px-3 py-2">
        <div className="flex items-center gap-1">
          <Tooltip label={isWeek ? "Previous week" : "Previous day"} shortcut="[">
            <button
              type="button"
              aria-label={isWeek ? "Previous week" : "Previous day"}
              onClick={goPrev}
              className="rounded-md p-1.5 text-text-secondary hover:bg-surface-well"
            >
              <ChevronLeftIcon className="h-4 w-4" />
            </button>
          </Tooltip>
          <Tooltip label="Jump to today" shortcut="T">
            <button
              type="button"
              onClick={goToday}
              className="rounded-control border border-border-interactive px-2.5 py-1 text-sm text-text-primary hover:bg-surface-well"
            >
              Today
            </button>
          </Tooltip>
          <Tooltip label={isWeek ? "Next week" : "Next day"} shortcut="]">
            <button
              type="button"
              aria-label={isWeek ? "Next week" : "Next day"}
              onClick={goNext}
              className="rounded-md p-1.5 text-text-secondary hover:bg-surface-well"
            >
              <ChevronRightIcon className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>

        <Popover
          trigger={(props) => (
            <button
              {...props}
              className="rounded-control px-2 py-1 text-sm font-medium text-text-primary hover:bg-surface-well"
            >
              {formatToolbarDate(sheet.date, sheet.days)}
            </button>
          )}
        >
          {(close) => (
            <MiniCalendar
              selected={sheet.date}
              weekMode={isWeek}
              onPick={(date) => {
                close();
                pickDate(date);
              }}
              onClose={close}
            />
          )}
        </Popover>

        <span className="text-sm text-text-secondary tabular-nums">
          {visibleAppointments.length === 1
            ? "1 appointment"
            : `${visibleAppointments.length} appointments`}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {isWeek && sheet.practitioners.length > 1 && (
            <Popover
              align="end"
              trigger={(props) => (
                <button
                  {...props}
                  className="flex items-center gap-1.5 rounded-control border border-border-interactive px-2.5 py-1 text-sm text-text-primary hover:bg-surface-well"
                >
                  {selectedName ?? "Practitioner"}
                  <ChevronDownIcon className="h-3.5 w-3.5 text-text-secondary" />
                </button>
              )}
            >
              {(close) => (
                <div className="flex w-48 flex-col rounded-lg border border-border-hairline bg-surface-card p-1 shadow-lg">
                  {sheet.practitioners.map((p) => (
                    <button
                      key={p.practitionerId}
                      type="button"
                      aria-current={p.practitionerId === selectedPractitioner}
                      onClick={() => {
                        selectPractitioner(p.practitionerId);
                        close();
                      }}
                      className={`rounded-md px-2.5 py-1.5 text-left text-sm ${
                        p.practitionerId === selectedPractitioner
                          ? "bg-brand-wash font-medium text-brand-primary"
                          : "text-text-primary hover:bg-surface-well"
                      }`}
                    >
                      {p.practitionerName}
                    </button>
                  ))}
                </div>
              )}
            </Popover>
          )}

          <Popover
            align="end"
            trigger={(props) => (
              <button
                {...props}
                className="flex items-center gap-1.5 rounded-control border border-border-interactive px-2.5 py-1 text-sm text-text-primary hover:bg-surface-well"
              >
                {isWeek ? "Week" : "Day"}
                <ChevronDownIcon className="h-3.5 w-3.5 text-text-secondary" />
              </button>
            )}
          >
            {(close) => (
              <div className="flex w-40 flex-col rounded-lg border border-border-hairline bg-surface-card p-1 shadow-lg">
                {(
                  [
                    { v: "day", label: "Day", key: "D" },
                    { v: "week", label: "Week", key: "W" },
                  ] as const
                ).map(({ v, label, key }) => (
                  <button
                    key={v}
                    type="button"
                    aria-current={v === view}
                    onClick={() => {
                      close();
                      if (v !== view) setView(v);
                    }}
                    className={`flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm ${
                      v === view
                        ? "bg-brand-wash font-medium text-brand-primary"
                        : "text-text-primary hover:bg-surface-well"
                    }`}
                  >
                    {label}
                    <kbd className="font-mono text-[10px] text-text-secondary">{key}</kbd>
                  </button>
                ))}
                {/* Month is a different data shape (SCHEDULE_DESIGN.md) — honestly Soon. */}
                <span className="flex items-center justify-between rounded-md px-2.5 py-1.5 text-sm text-text-secondary">
                  Month
                  <span className="rounded-full bg-surface-well px-2 py-0.5 text-xs">Soon</span>
                </span>
              </div>
            )}
          </Popover>

          <Popover
            align="end"
            trigger={(props) => (
              <Tooltip label="Keyboard shortcuts" shortcut="?">
                <button
                  {...props}
                  aria-label="Keyboard shortcuts"
                  className="rounded-md p-1.5 text-text-secondary hover:bg-surface-well"
                >
                  <KeyboardIcon className="h-4 w-4" />
                </button>
              </Tooltip>
            )}
          >
            {(close) => <ShortcutsPopover onClose={close} />}
          </Popover>
        </div>
      </div>

      {/* Live region for action failures / conflicts (names the staff member already sees). */}
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

      {/* ---- Scrolling grid ---- */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" onKeyDown={onGridKeyDown}>
        <div className="min-w-fit">
          {/* Sticky column headers */}
          <div className="sticky top-0 z-20 flex border-b border-border-hairline bg-surface-card">
            <div className="w-14 shrink-0" aria-hidden />
            {columns.map((c) => (
              <div
                key={c.key}
                className="min-w-40 flex-1 border-l border-border-hairline px-3 py-2.5"
              >
                {c.header}
              </div>
            ))}
          </div>

          <div className="relative flex" style={{ height: GRID_HEIGHT }}>
            {/* Sticky time gutter */}
            <div className="sticky left-0 z-10 w-14 shrink-0 bg-surface-card" aria-hidden>
              {hours.map((hour) => (
                <span
                  key={hour}
                  className="absolute right-2 -translate-y-1/2 text-[11px] text-text-secondary tabular-nums"
                  style={{ top: (hour - DAY_START_HOUR) * HOUR_PX }}
                >
                  {hour === DAY_START_HOUR ? "" : formatHour(hour)}
                </span>
              ))}
            </div>

            {/* Hour lines + now line */}
            <div className="pointer-events-none absolute inset-y-0 right-0 left-14" aria-hidden>
              {hours.map((hour) => (
                <div
                  key={hour}
                  className="absolute right-0 left-0 border-t border-border-hairline"
                  style={{ top: (hour - DAY_START_HOUR) * HOUR_PX }}
                />
              ))}
              {nowTop !== undefined && (
                <div
                  data-testid="now-line"
                  className="absolute right-0 left-0 border-t-2 border-brand-primary"
                  style={{ top: nowTop }}
                >
                  <span className="absolute -top-1 -left-1 h-2 w-2 rounded-full bg-brand-primary" />
                </div>
              )}
            </div>

            {/* Columns */}
            {columns.map((c) => (
              <div
                key={c.key}
                role="list"
                className="relative min-w-40 flex-1 border-l border-border-hairline"
              >
                {c.appointments.map((a) => {
                  const status = statuses[a.id] ?? a.status;
                  const { top, height } = blockGeometry(a, tz, DAY_START_HOUR);
                  const edge = a.serviceColor
                    ? CATEGORY_EDGE[a.serviceColor]
                    : "border-l-border-interactive";
                  const dimmed = status === "completed" || status === "no-show";
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
                          dimmed ? "opacity-70" : ""
                        }`}
                      >
                        {isWeek ? (
                          <span className="flex items-center gap-1.5">
                            <span
                              aria-hidden
                              className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[status]}`}
                            />
                            <span className="truncate text-[12px] text-text-secondary tabular-nums">
                              {formatTime(a.start, tz)}
                            </span>
                            <span className="truncate text-[12px] font-medium text-text-primary">
                              {a.patientName}
                            </span>
                            <span className="sr-only">{STATUS_LABEL[status]}</span>
                          </span>
                        ) : (
                          <>
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
                          </>
                        )}
                      </button>
                      {!isWeek && status === "scheduled" && (
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
          </div>
        </div>
      </div>

      {visibleAppointments.length === 0 && (
        <div className="border-t border-border-hairline px-5 py-4 text-center">
          <p className="text-sm font-medium text-text-primary">
            {isWeek ? "No appointments this week." : "No appointments on this day."}
          </p>
          <p className="mt-1 text-sm text-text-secondary">
            Portal bookings appear here as they land.
          </p>
        </div>
      )}

      {/* ---- Detail card ---- */}
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

      {/* ---- Undo toast ---- */}
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
