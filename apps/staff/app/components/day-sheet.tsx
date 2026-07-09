"use client";

import {
  createApiClient,
  StaffError,
  type AppointmentStatus,
  type CreateInternalEventRequest,
  type DaySheet,
  type DaySheetAppointment,
  type InternalEvent,
} from "@medibun/api-client";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  ACTION_DONE,
  blockGeometry,
  CATEGORY_EDGE,
  columnLayout,
  daySpan,
  DAY_END_HOUR,
  DAY_START_HOUR,
  EVENT_TYPE_LABEL,
  formatBookedAt,
  formatColumnDay,
  formatHour,
  formatMinutesLabel,
  formatTime,
  formatToolbarDate,
  FORWARD_ACTIONS,
  HOUR_PX,
  hourOf,
  isAllDayEvent,
  minutesToWallTime,
  shiftYmd,
  snapMinutes,
  STATUS_CHIP,
  STATUS_DOT,
  STATUS_LABEL,
  VIEW_DAYS,
  wallTime,
  weekStart,
  ymdOf,
  type ScheduleView,
} from "../lib/day-sheet";
import { IDLE_MASK_MS, maskName, POLL_INTERVAL_MS } from "../lib/privacy";
import { EventForm } from "./event-form";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  KeyboardIcon,
  PlusIcon,
} from "./icons";
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

/** The undo toast's cargo — carries the full object, not just an id, so the undo
 *  keeps working after a navigation swaps the sheet out from under it. */
type Undo =
  | {
      readonly kind: "status";
      readonly appointment: DaySheetAppointment;
      readonly from: AppointmentStatus;
      readonly to: AppointmentStatus;
      readonly expiresAt: number;
    }
  | {
      readonly kind: "event";
      readonly event: InternalEvent;
      readonly action: "added" | "removed";
      readonly expiresAt: number;
    }
  | {
      /** Drag-to-reschedule (S5.5): undo moves the appointment back to its ORIGINAL
       *  window/practitioner (a compensating reverse reschedule). */
      readonly kind: "move";
      readonly appointment: DaySheetAppointment;
      readonly expiresAt: number;
    };

/** A live drag: the ghost's target column + snapped start (minutes-of-day).
 *  Duration comes from the appointment itself — no derived copies. */
type DragState = {
  readonly appointment: DaySheetAppointment;
  readonly columnIndex: number;
  readonly minutes: number;
};

/** A rendered column: practitioners (day view) or weekdays (week view). */
type Column = {
  readonly key: string;
  readonly appointments: DaySheetAppointment[];
  /** Internal events overlapping this column (day off / meeting / block — no PHI). */
  readonly events: InternalEvent[];
  readonly header: React.ReactNode;
  /** Accessible name for the column's appointment list. */
  readonly label: string;
};

/** Column order is time order — arrow-key movement and screen-reader reading depend on
 *  it, so sort here instead of trusting the wire order. */
const byStart = (x: DaySheetAppointment, y: DaySheetAppointment) => x.start.localeCompare(y.start);

/** Longest event first: DOM order is paint order, so a meeting inside a day-off wash
 *  stays visible and clickable above it. */
const byDurationDesc = (x: InternalEvent, y: InternalEvent) =>
  Date.parse(y.end) - Date.parse(y.start) - (Date.parse(x.end) - Date.parse(x.start));

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

  // Optimistic status OVERRIDES on top of the sheet (never a mirror of it in state);
  // a refreshed sheet is server truth and clears them (below).
  const [overrides, setOverrides] = useState<Record<string, AppointmentStatus>>({});
  const statusOf = (a: DaySheetAppointment) => overrides[a.id] ?? a.status;

  // Week filter: an in-page pick (replaceState, no refetch) wins while valid, else the
  // URL param, else the signed-in practitioner (when they have a column), else column 1.
  const practitionerIds = useMemo(() => sheet.practitioners.map((p) => p.practitionerId), [sheet]);
  const defaultPractitioner =
    (selfPractitionerId && practitionerIds.includes(selfPractitionerId)
      ? selfPractitionerId
      : undefined) ?? practitionerIds[0];
  const [picked, setPicked] = useState<string | undefined>();
  const selectedPractitioner =
    (picked && practitionerIds.includes(picked) ? picked : undefined) ??
    (practitionerId && practitionerIds.includes(practitionerId)
      ? practitionerId
      : defaultPractitioner);

  const [focusedId, setFocusedId] = useState<string | undefined>();
  const [detailId, setDetailId] = useState<string | undefined>();
  const [eventDetailId, setEventDetailId] = useState<string | undefined>();
  const [shortcutsOpen, setShortcutsOpen] = useState(false); // controlled: "?" opens it
  const [createOpen, setCreateOpen] = useState(false); // controlled: "N" opens it
  const [undo, setUndo] = useState<Undo | undefined>();
  const [undoSecondsLeft, setUndoSecondsLeft] = useState(0);
  const [notice, setNotice] = useState<string | undefined>();
  const [nowMs, setNowMs] = useState<number | undefined>(); // client clock, set after mount

  // Privacy glance mask (S5b): patient names render as initials and the detail card's
  // contact details hide — a display-layer safeguard for walk-behind moments; the
  // session is never touched. One tap / P toggles it; idleness engages it (below).
  const [masked, setMasked] = useState(false);
  const displayName = (name: string) => (masked ? maskName(name) : name);

  // ---- Drag-to-reschedule (S5.5, day view, mouse) ------------------------------
  // Server-confirmed MOVES on top of the sheet (like status overrides): the drop
  // applies the BFF response; the next refreshed sheet is server truth and clears it.
  const [moves, setMoves] = useState<
    Record<string, { start: string; end: string; practitionerId: string }>
  >({});
  const [drag, setDrag] = useState<DragState | undefined>();
  /** Armed on pointerdown; becomes a drag after ~6px of travel (else it's a click). */
  const dragArm = useRef<
    | {
        appointment: DaySheetAppointment;
        pointerId: number | undefined;
        startX: number;
        startY: number;
        grabOffsetY: number;
      }
    | undefined
  >(undefined);
  const dragLive = useRef<DragState | undefined>(undefined);
  const suppressClick = useRef(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const dayColumnRefs = useRef(new Map<number, HTMLDivElement>());

  // A new sheet (refresh/navigation) is server truth arriving: drop the optimistic
  // overrides, drop a keyboard cursor pointing at an appointment that no longer exists
  // (a stale focusedId leaves NO block tabbable — the keyboard dies), and let a real
  // navigation's URL param beat an in-page pick. Adjusted during render, not an effect.
  const [prev, setPrev] = useState({ sheet, practitionerId });
  if (prev.sheet !== sheet || prev.practitionerId !== practitionerId) {
    setPrev({ sheet, practitionerId });
    setOverrides({});
    setMoves({});
    if (prev.practitionerId !== practitionerId) {
      setPicked(undefined);
    }
    if (focusedId && !sheet.appointments.some((a) => a.id === focusedId)) {
      setFocusedId(undefined);
    }
  }

  const blockRefs = useRef(new Map<string, HTMLButtonElement>());
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Confirmed moves applied over the wire sheet — everything downstream (columns,
  // keyboard map, detail card) sees the moved appointment where it now lives.
  const effectiveAppointments = useMemo(
    () =>
      sheet.appointments.map((a) => {
        const move = moves[a.id];
        return move ? { ...a, ...move } : a;
      }),
    [sheet, moves],
  );

  // ---- Columns ---------------------------------------------------------------
  const columns: Column[] = useMemo(() => {
    if (isWeek) {
      const mine = effectiveAppointments.filter((a) => a.practitionerId === selectedPractitioner);
      const myEvents = sheet.events.filter(
        (e) => selectedPractitioner && e.practitionerIds.includes(selectedPractitioner),
      );
      return daySpan(sheet.date, sheet.days).map((ymd) => {
        const { weekday, day } = formatColumnDay(ymd);
        return {
          key: ymd,
          appointments: mine.filter((a) => ymdOf(a.start, tz) === ymd).sort(byStart),
          events: myEvents.filter((e) => ymdOf(e.start, tz) === ymd).sort(byDurationDesc),
          header: (
            <span className="flex items-baseline gap-1.5">
              <span className="text-sm font-medium text-text-primary">{weekday}</span>
              <span className="text-sm text-text-secondary tabular-nums">{day}</span>
            </span>
          ),
          label: `${weekday} ${day} appointments`,
        };
      });
    }
    return sheet.practitioners.map((p) => ({
      key: p.practitionerId,
      appointments: effectiveAppointments
        .filter((a) => a.practitionerId === p.practitionerId)
        .sort(byStart),
      events: sheet.events
        .filter((e) => e.practitionerIds.includes(p.practitionerId))
        .sort(byDurationDesc),
      header: <span className="text-sm font-medium text-text-primary">{p.practitionerName}</span>,
      label: `${p.practitionerName} appointments`,
    }));
  }, [sheet, effectiveAppointments, isWeek, selectedPractitioner, tz]);

  const appointmentById = useMemo(
    () => new Map(effectiveAppointments.map((a) => [a.id, a])),
    [effectiveAppointments],
  );
  const eventById = useMemo(() => new Map(sheet.events.map((e) => [e.id, e])), [sheet]);
  const visibleAppointments = useMemo(() => columns.flatMap((c) => c.appointments), [columns]);
  const firstFocusableId = columns.find((c) => c.appointments.length > 0)?.appointments[0]?.id;

  // ---- Clock + auto-scroll ---------------------------------------------------
  useEffect(() => {
    setNowMs(Date.now());
    const interval = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  // Idle auto-engage (S5b, the HIPAA addressable-safeguard alignment): any
  // interaction restarts the clock; IDLE_MASK_MS of stillness masks the screen.
  // Checked on a coarse interval — per-event timer churn buys nothing here.
  const lastActivityRef = useRef(Date.now());
  useEffect(() => {
    const bump = () => {
      lastActivityRef.current = Date.now();
    };
    const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
    for (const event of events) {
      window.addEventListener(event, bump, { passive: true });
    }
    const interval = setInterval(() => {
      if (Date.now() - lastActivityRef.current >= IDLE_MASK_MS) {
        setMasked(true);
      }
    }, 10_000);
    return () => {
      for (const event of events) {
        window.removeEventListener(event, bump);
      }
      clearInterval(interval);
    };
  }, []);

  // Live updates (S5b): another station's changes appear without a manual refresh —
  // a quiet RSC refetch on an interval while the tab is visible, plus a catch-up when
  // it becomes visible again. Paused while a status write is in flight so an
  // optimistic chip never flickers back to the pre-write status mid-request.
  const pendingWrites = useRef(0);
  useEffect(() => {
    const refetch = () => {
      if (!document.hidden && pendingWrites.current === 0) {
        router.refresh();
      }
    };
    const interval = setInterval(refetch, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", refetch);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refetch);
    };
  }, [router]);

  const days = daySpan(sheet.date, sheet.days);
  const nowYmd = nowMs === undefined ? undefined : ymdOf(new Date(nowMs).toISOString(), tz);
  const nowInView = nowYmd !== undefined && days.includes(nowYmd);
  const nowHour = nowMs === undefined ? undefined : hourOf(new Date(nowMs).toISOString(), tz);

  // Scroll to ~1h before now (today in view) or the first appointment, once per view of
  // the sheet. Reads the clock directly (not the ticking state) so a minute tick never
  // yanks the scroll back. Keyed on what the user is LOOKING AT (view/date/filter), not
  // the sheet object — a background live-update refetch must keep their scroll.
  const scrollKeyRef = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const key = [view, sheet.date, sheet.days, selectedPractitioner].join("|");
    if (scrollKeyRef.current === key) {
      return;
    }
    scrollKeyRef.current = key;
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
    setOverrides((s) => ({ ...s, [appointment.id]: to }));
    setDetailId(undefined);
    pendingWrites.current += 1;
    try {
      await api.setAppointmentStatus(appointment.id, to);
      if (withUndo) {
        setUndo({ kind: "status", appointment, from, to, expiresAt: Date.now() + UNDO_WINDOW_MS });
      }
    } catch (err) {
      setOverrides((s) => ({ ...s, [appointment.id]: from }));
      if (err instanceof StaffError && err.code === "conflict") {
        setNotice("That appointment changed on another station. Refreshing the schedule.");
        router.refresh();
      } else {
        setNotice("Couldn't update the appointment. Try again.");
      }
    } finally {
      pendingWrites.current -= 1;
    }
  }

  function act(appointment: DaySheetAppointment, to: AppointmentStatus) {
    const from = statusOf(appointment);
    if (from === to) {
      return;
    }
    void writeStatus(appointment, from, to, true);
  }

  function undoNow() {
    if (!undo) {
      return;
    }
    const entry = undo;
    setUndo(undefined);
    // The toast carries the object itself, so undo works even after the sheet
    // navigated away from the day it lives on.
    if (entry.kind === "status") {
      void writeStatus(entry.appointment, entry.to, entry.from, false);
    } else if (entry.kind === "move") {
      void undoMove(entry.appointment);
    } else {
      void undoEvent(entry);
    }
  }

  /** Undo a drag: a compensating reschedule back to the ORIGINAL window/practitioner.
   *  It can itself 409 (someone took the old window) — surface that honestly.
   *  Optimistic like writeStatus: the move overlay reverts up front (the grid shows
   *  the original window immediately) and rolls back if the write fails. */
  async function undoMove(original: DaySheetAppointment) {
    const overlay = moves[original.id];
    setMoves((m) => Object.fromEntries(Object.entries(m).filter(([id]) => id !== original.id)));
    pendingWrites.current += 1;
    try {
      await api.rescheduleAppointment(original.id, {
        date: ymdOf(original.start, tz),
        startTime: wallTime(original.start, tz),
        practitionerId: original.practitionerId,
      });
      router.refresh();
    } catch (err) {
      if (overlay) {
        setMoves((m) => ({ ...m, [original.id]: overlay }));
      }
      if (err instanceof StaffError && err.code === "conflict") {
        setNotice("The original time is no longer free. Refreshing the schedule.");
        router.refresh();
      } else {
        // Restore the undo affordance — "Try again" must have a button to press.
        setUndo({ kind: "move", appointment: original, expiresAt: Date.now() + UNDO_WINDOW_MS });
        setNotice("Couldn't undo the move. Try again.");
      }
    } finally {
      pendingWrites.current -= 1;
    }
  }

  // ---- Internal events (S5c) --------------------------------------------------
  /** An event back as the practice-local request that recreates it (undo of delete). */
  function recreateRequest(event: InternalEvent): CreateInternalEventRequest {
    return {
      type: event.type,
      ...(event.title ? { title: event.title } : {}),
      practitionerIds: event.practitionerIds,
      date: ymdOf(event.start, tz),
      ...(isAllDayEvent(event, tz)
        ? { allDay: true }
        : { startTime: wallTime(event.start, tz), endTime: wallTime(event.end, tz) }),
    };
  }

  async function undoEvent(entry: Extract<Undo, { kind: "event" }>) {
    try {
      if (entry.action === "added") {
        await api.deleteInternalEvent(entry.event.id);
      } else {
        await api.createInternalEvent(recreateRequest(entry.event));
      }
      router.refresh();
    } catch {
      setNotice("Couldn't undo that. Check the schedule and try again.");
    }
  }

  /** Called by the New-event form; a rejection keeps the form open with its error. */
  async function addEvent(request: CreateInternalEventRequest) {
    const event = await api.createInternalEvent(request);
    setCreateOpen(false);
    setUndo({ kind: "event", event, action: "added", expiresAt: Date.now() + UNDO_WINDOW_MS });
    router.refresh();
  }

  async function removeEvent(event: InternalEvent) {
    setEventDetailId(undefined);
    try {
      await api.deleteInternalEvent(event.id);
      setUndo({ kind: "event", event, action: "removed", expiresAt: Date.now() + UNDO_WINDOW_MS });
    } catch (err) {
      if (err instanceof StaffError && err.code === "not_found") {
        setNotice("That event was already removed on another station.");
      } else {
        setNotice("Couldn't remove the event. Try again.");
        return;
      }
    }
    router.refresh();
  }

  // ---- Drag-to-reschedule handlers (S5.5) -------------------------------------
  /** Pointerdown on a block arms a potential drag. Mouse only for now: on touch,
   *  a finger on a block must keep scrolling the grid (touch parity is a queued
   *  follow-up in SCHEDULE_DESIGN.md §10). */
  function armDrag(event: React.PointerEvent, appointment: DaySheetAppointment) {
    if (isWeek || event.pointerType === "touch" || event.pointerType === "pen") {
      return;
    }
    if (event.button !== 0 || statusOf(appointment) !== "scheduled" || drag) {
      return;
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    dragArm.current = {
      appointment,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      grabOffsetY: event.clientY - rect.top,
    };
  }

  /** Full drag teardown — the one owner of the lifecycle's reset invariant
   *  (drop, Escape, and pointercancel all end a drag through here). */
  function clearDrag() {
    dragArm.current = undefined;
    dragLive.current = undefined;
    setDrag(undefined);
  }

  async function dropDrag() {
    const dropped = dragLive.current;
    clearDrag();
    if (!dropped) {
      return;
    }
    const target = columns[dropped.columnIndex];
    const startTime = minutesToWallTime(dropped.minutes);
    if (
      !target ||
      (target.key === dropped.appointment.practitionerId &&
        startTime === wallTime(dropped.appointment.start, tz))
    ) {
      return; // dropped back where it was — nothing to do
    }
    pendingWrites.current += 1;
    try {
      const moved = await api.rescheduleAppointment(dropped.appointment.id, {
        date: sheet.date,
        startTime,
        practitionerId: target.key, // day-view column keys ARE practitioner ids
      });
      // The response is server truth — apply it until the next refreshed sheet lands.
      setMoves((m) => ({
        ...m,
        [moved.id]: { start: moved.start, end: moved.end, practitionerId: moved.practitionerId },
      }));
      setUndo({
        kind: "move",
        appointment: dropped.appointment,
        expiresAt: Date.now() + UNDO_WINDOW_MS,
      });
      router.refresh();
    } catch (err) {
      if (err instanceof StaffError && err.code === "conflict") {
        setNotice("That time is taken, or the appointment changed. Refreshing the schedule.");
        router.refresh();
      } else {
        setNotice("Couldn't move the appointment. Try again.");
      }
    } finally {
      pendingWrites.current -= 1;
    }
  }

  // Window-level drag tracking. Re-subscribed per render (this file's listener
  // pattern) so the handlers always close over fresh state.
  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const arm = dragArm.current;
      if (!arm || event.pointerId !== arm.pointerId) {
        return;
      }
      if (
        !dragLive.current &&
        Math.abs(event.clientX - arm.startX) + Math.abs(event.clientY - arm.startY) < 6
      ) {
        return; // still a click until the pointer commits to traveling
      }
      const grid = gridRef.current?.getBoundingClientRect();
      if (!grid) {
        return;
      }
      suppressClick.current = true;
      let columnIndex = dragLive.current?.columnIndex ?? 0;
      dayColumnRefs.current.forEach((el, index) => {
        const rect = el.getBoundingClientRect();
        if (event.clientX >= rect.left && event.clientX < rect.right) {
          columnIndex = index;
        }
      });
      const minutes = snapMinutes(event.clientY - grid.top - arm.grabOffsetY);
      // Most pixels don't cross a 15-min snap step or a column edge — skip the
      // whole-view re-render (and the deps-less effects' listener churn) when the
      // ghost wouldn't actually move.
      const live = dragLive.current;
      if (live && live.minutes === minutes && live.columnIndex === columnIndex) {
        return;
      }
      const next: DragState = { appointment: arm.appointment, columnIndex, minutes };
      dragLive.current = next;
      setDrag(next);
    };
    const onPointerUp = (event: PointerEvent) => {
      const arm = dragArm.current;
      if (!arm || event.pointerId !== arm.pointerId) {
        return;
      }
      void dropDrag();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dragLive.current) {
        clearDrag();
      }
    };
    // A cancelled pointer (window blur, native drag interception, gesture) never
    // delivers pointerup — without this the ghost stays painted and the armDrag
    // guard blocks every future drag until Escape.
    const onPointerCancel = (event: PointerEvent) => {
      const arm = dragArm.current;
      if (!arm || event.pointerId !== arm.pointerId) {
        return;
      }
      clearDrag();
      suppressClick.current = false; // no click follows a cancelled pointer
    };
    // The gesture's own click (dispatched after pointerup, bubbling past React's
    // root) is the LAST place suppressClick matters: a block's onClick consumed it
    // if the drop landed on the origin block; clearing here covers every other
    // landing spot (another column, empty grid, post-Escape release) so the flag
    // can't leak and swallow the user's next real click.
    const onWindowClick = () => {
      suppressClick.current = false;
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("click", onWindowClick);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("click", onWindowClick);
    };
  });

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
    setPicked(id);
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
      // The privacy mask outranks the panel guard below: a walk-behind moment can't
      // wait for whoever left a detail card open to press Escape first.
      if (event.key.toLowerCase() === "p") {
        event.preventDefault();
        setMasked((m) => !m);
        return;
      }
      // An open panel owns the keyboard: T in the date picker or D under the detail
      // card must not yank the page to another day/view (panels close on Escape).
      if (document.querySelector('[role="dialog"], [data-popover-panel]')) {
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
        case "n":
          event.preventDefault();
          setCreateOpen(true);
          break;
        case "z":
          // Global, not grid-only: the undo toast must answer Z wherever focus sits.
          if (undo) {
            event.preventDefault();
            undoNow();
          }
          break;
        case "?":
          event.preventDefault();
          setShortcutsOpen(true);
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
    if (event.key.toLowerCase() === "c" && statusOf(current) === "scheduled") {
      event.preventDefault();
      act(current, "arrived");
    }
  }

  const detail = detailId ? appointmentById.get(detailId) : undefined;
  const detailStatus = detail ? statusOf(detail) : undefined;
  const eventDetail = eventDetailId ? eventById.get(eventDetailId) : undefined;
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
          <Popover
            align="end"
            open={createOpen}
            onOpenChange={setCreateOpen}
            trigger={(props) => (
              <Tooltip label="New event" shortcut="N">
                <button
                  {...props}
                  className="flex items-center gap-1.5 rounded-control border border-border-interactive px-2.5 py-1 text-sm text-text-primary hover:bg-surface-well"
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                  New
                </button>
              </Tooltip>
            )}
          >
            {(close) => (
              <EventForm
                practitioners={sheet.practitioners}
                defaultPractitionerId={isWeek ? selectedPractitioner : defaultPractitioner}
                defaultDate={sheet.date}
                onCreate={addEvent}
                onClose={close}
              />
            )}
          </Popover>

          <Tooltip label="Privacy mask" shortcut="P">
            <button
              type="button"
              aria-label="Privacy mask"
              aria-pressed={masked}
              onClick={() => setMasked((m) => !m)}
              className={`rounded-md p-1.5 ${
                masked
                  ? "bg-brand-wash text-brand-primary"
                  : "text-text-secondary hover:bg-surface-well"
              }`}
            >
              {masked ? <EyeOffIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
            </button>
          </Tooltip>

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
            open={shortcutsOpen}
            onOpenChange={setShortcutsOpen}
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
      <div
        ref={scrollRef}
        data-testid="schedule-scroll"
        className="min-h-0 flex-1 overflow-auto"
        onKeyDown={onGridKeyDown}
      >
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

          <div
            ref={gridRef}
            data-testid="schedule-grid"
            className="relative flex"
            style={{ height: GRID_HEIGHT }}
          >
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
                  className="absolute right-0 left-0"
                  style={{ top: nowTop }}
                >
                  {/* Zero-height anchor at the current time; line and dot self-center on it
                      with transforms (the calendar-app pattern). A border-t line would push
                      absolutely-positioned children to the padding box and un-center the dot.
                      Dot stays flush left: overhang slides under the sticky time gutter. */}
                  <div className="absolute inset-x-0 h-0.5 -translate-y-1/2 bg-brand-primary" />
                  <span className="absolute left-0 h-2 w-2 -translate-y-1/2 rounded-full bg-brand-primary" />
                </div>
              )}
            </div>

            {/* Columns */}
            {columns.map((c, columnIndex) => {
              // Overlapping appointments share the column side by side (4D-study
              // defect-class fix) — a solo block still spans the full width.
              const layout = columnLayout(c.appointments);
              return (
                <div
                  key={c.key}
                  role="list"
                  aria-label={c.label}
                  ref={(el) => {
                    if (el) {
                      dayColumnRefs.current.set(columnIndex, el);
                    } else {
                      dayColumnRefs.current.delete(columnIndex);
                    }
                  }}
                  className="relative min-w-40 flex-1 border-l border-border-hairline"
                >
                  {/* Drag ghost: the snapped landing window in the hovered column. */}
                  {!isWeek && drag && drag.columnIndex === columnIndex && (
                    <div
                      data-testid="drag-ghost"
                      className="pointer-events-none absolute right-1.5 left-1.5 z-30 rounded-md border-2 border-dashed border-action-primary bg-brand-wash/70 px-2 py-1"
                      style={{
                        top: (drag.minutes / 60) * HOUR_PX,
                        height:
                          ((Date.parse(drag.appointment.end) - Date.parse(drag.appointment.start)) /
                            3600_000) *
                          HOUR_PX,
                      }}
                    >
                      <span className="text-[11px] font-medium text-brand-primary tabular-nums">
                        {formatMinutesLabel(drag.minutes)}
                      </span>
                    </div>
                  )}
                  {/* Internal events first (DOM order = paint order): appointments
                    stack above an overlapping all-day wash, never under it. */}
                  {c.events.map((e) => {
                    const { top, height } = blockGeometry(e, tz, DAY_START_HOUR);
                    const label = e.title ?? EVENT_TYPE_LABEL[e.type];
                    return (
                      <div
                        key={e.id}
                        className="absolute right-1.5 left-1.5"
                        style={{ top, height }}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            setEventDetailId(e.id === eventDetailId ? undefined : e.id)
                          }
                          aria-haspopup="dialog"
                          aria-expanded={eventDetailId === e.id}
                          aria-label={`${label} — event details`}
                          className="block h-full w-full overflow-hidden rounded-md border border-dashed border-border-interactive bg-surface-well/70 px-2 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-action-primary"
                        >
                          <span className="block truncate text-[11px] text-text-secondary tabular-nums">
                            {isAllDayEvent(e, tz)
                              ? "All day"
                              : `${formatTime(e.start, tz)}–${formatTime(e.end, tz)}`}
                          </span>
                          <span className="block truncate text-[12px] font-medium text-text-secondary">
                            {label}
                          </span>
                        </button>
                      </div>
                    );
                  })}
                  {c.appointments.map((a) => {
                    const status = statusOf(a);
                    const { top, height } = blockGeometry(a, tz, DAY_START_HOUR);
                    // Lane geometry: lanes=1 reproduces the old full-width insets.
                    const { lane, lanes } = layout.get(a.id) ?? { lane: 0, lanes: 1 };
                    const edge = a.serviceColor
                      ? CATEGORY_EDGE[a.serviceColor]
                      : "border-l-border-interactive";
                    const dimmed = status === "completed" || status === "no-show";
                    return (
                      <div
                        key={a.id}
                        role="listitem"
                        className="absolute"
                        style={{
                          top,
                          height,
                          left: `calc(${(lane * 100) / lanes}% + 0.375rem)`,
                          width: `calc(${100 / lanes}% - 0.75rem)`,
                        }}
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
                          onPointerDown={(event) => armDrag(event, a)}
                          onClick={() => {
                            // A finished drag ends where a click would begin — swallow it.
                            if (suppressClick.current) {
                              suppressClick.current = false;
                              return;
                            }
                            setDetailId(a.id === detailId ? undefined : a.id);
                          }}
                          aria-haspopup="dialog"
                          aria-expanded={detailId === a.id}
                          className={`block h-full w-full overflow-hidden rounded-md border border-border-hairline border-l-4 bg-surface-card px-2 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-action-primary ${edge} ${
                            dimmed ? "opacity-70" : ""
                          } ${!isWeek && status === "scheduled" ? "cursor-grab" : ""} ${
                            drag?.appointment.id === a.id ? "opacity-40" : ""
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
                                {displayName(a.patientName)}
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
                                  {displayName(a.patientName)}
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
                            aria-label={`Check in ${displayName(a.patientName)}`}
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
              );
            })}
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
          aria-label={`Appointment details — ${displayName(detail.patientName)}`}
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
                <span className="truncate">{displayName(detail.patientName)}</span>
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
          {/* While masked, present details read "Hidden" (never the value); a missing
              value keeps its honest em dash. */}
          <dl className="mt-3 border-t border-border-hairline pt-2">
            <DetailRow
              label="Phone"
              value={masked && detail.patientPhone ? "Hidden" : detail.patientPhone}
            />
            <DetailRow
              label="Email"
              value={masked && detail.patientEmail ? "Hidden" : detail.patientEmail}
            />
            <DetailRow
              label="Booked"
              value={
                detail.bookedAt
                  ? masked
                    ? "Hidden"
                    : formatBookedAt(detail.bookedAt, tz)
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

      {/* ---- Event detail card (no PHI — titles are non-PHI by rule) ---- */}
      {eventDetail && (
        <div
          role="dialog"
          aria-label={`Event details — ${eventDetail.title ?? EVENT_TYPE_LABEL[eventDetail.type]}`}
          className="fixed inset-x-4 bottom-4 z-40 rounded-lg border border-border-hairline bg-surface-card p-4 shadow-lg outline-none md:inset-x-auto md:right-6 md:bottom-6 md:w-96"
        >
          <p className="text-sm font-medium text-text-primary">
            {eventDetail.title ?? EVENT_TYPE_LABEL[eventDetail.type]}
          </p>
          <p className="mt-0.5 text-xs text-text-secondary">
            {EVENT_TYPE_LABEL[eventDetail.type]} ·{" "}
            {isAllDayEvent(eventDetail, tz)
              ? "All day"
              : `${formatTime(eventDetail.start, tz)}–${formatTime(eventDetail.end, tz)}`}
          </p>
          <p className="mt-1 text-xs text-text-secondary">
            {eventDetail.practitionerIds
              .map(
                (id) =>
                  sheet.practitioners.find((p) => p.practitionerId === id)?.practitionerName ??
                  "Unknown",
              )
              .join(", ")}
          </p>
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-border-hairline pt-3">
            <button
              type="button"
              onClick={() => void removeEvent(eventDetail)}
              className="rounded-control border border-border-interactive px-3 py-1.5 text-sm text-status-danger-text"
            >
              Delete
            </button>
            <button
              type="button"
              onClick={() => setEventDetailId(undefined)}
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
            {undo.kind === "status"
              ? `${ACTION_DONE[undo.to]} — ${displayName(undo.appointment.patientName)}`
              : undo.kind === "move"
                ? `Moved — ${displayName(undo.appointment.patientName)}`
                : `${undo.event.title ?? EVENT_TYPE_LABEL[undo.event.type]} ${
                    undo.action === "added" ? "added" : "removed"
                  }`}
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
