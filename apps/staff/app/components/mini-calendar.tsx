"use client";

import { useEffect, useRef, useState } from "react";

import { formatMonthYear, monthGrid, shiftYmd, weekStart } from "../lib/day-sheet";
import { ChevronLeftIcon, ChevronRightIcon } from "./icons";

/**
 * A quiet month-grid date picker in a popover (SCHEDULE_DESIGN.md). Monday-first to
 * match the week view. Keyboard: arrows move by day/week, Enter picks, Escape closes.
 * Pure client calendar math — no timezone (these are practice-local date labels).
 */

const WEEKDAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"];

export function MiniCalendar({
  selected,
  weekMode,
  onPick,
  onClose,
}: {
  /** Currently-viewed date (YYYY-MM-DD). */
  selected: string;
  /** In week view, highlight the whole Mon–Sun week the cursor sits in. */
  weekMode: boolean;
  onPick: (date: string) => void;
  onClose: () => void;
}) {
  // ONE cursor drives everything: the keyboard focus, the visible month (its grid), and
  // the chevrons. A separate month anchor desyncs — chevron then arrow-key snapped the
  // view back to the old cursor's month.
  const [cursor, setCursor] = useState(selected);
  const gridRef = useRef<HTMLDivElement>(null);
  const firstFocus = useRef(true);

  // Focus follows the cursor for keyboard moves (and on open); a chevron CLICK keeps its
  // button focused — yanking focus into the grid would break repeated month paging.
  useEffect(() => {
    const grid = gridRef.current;
    if (firstFocus.current || grid?.contains(document.activeElement)) {
      grid?.querySelector<HTMLButtonElement>('[data-cursor="true"]')?.focus();
    }
    firstFocus.current = false;
  }, [cursor]);

  const selectedWeek = weekMode ? weekStart(selected) : undefined;
  const cells = monthGrid(cursor);

  const move = (deltaDays: number) => setCursor(shiftYmd(cursor, deltaDays));

  /** Page the visible month by moving the cursor to the 1st of the prev/next month. */
  const pageMonth = (delta: -1 | 1) => {
    const first = `${cursor.slice(0, 7)}-01`;
    const inTarget = delta === -1 ? shiftYmd(first, -1) : shiftYmd(first, 32);
    setCursor(`${inTarget.slice(0, 7)}-01`);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const map: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    if (event.key in map) {
      event.preventDefault();
      move(map[event.key]!);
    } else if (event.key === "Enter") {
      event.preventDefault();
      onPick(cursor);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Choose date"
      className="w-64 rounded-lg border border-border-hairline bg-surface-card p-3 shadow-lg"
      onKeyDown={onKeyDown}
    >
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => pageMonth(-1)}
          className="rounded-md p-1 text-text-secondary hover:bg-surface-well"
        >
          <ChevronLeftIcon className="h-4 w-4" />
        </button>
        <span className="text-sm font-medium text-text-primary">{formatMonthYear(cursor)}</span>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => pageMonth(1)}
          className="rounded-md p-1 text-text-secondary hover:bg-surface-well"
        >
          <ChevronRightIcon className="h-4 w-4" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5" aria-hidden>
        {WEEKDAY_LABELS.map((d, i) => (
          <span key={i} className="py-1 text-center text-[11px] text-text-secondary">
            {d}
          </span>
        ))}
      </div>
      <div ref={gridRef} className="grid grid-cols-7 gap-0.5" role="grid">
        {cells.map(({ date, inMonth }) => {
          const isSelected = weekMode ? weekStart(date) === selectedWeek : date === selected;
          const isCursor = date === cursor;
          const [, , day] = date.split("-");
          return (
            <button
              key={date}
              type="button"
              role="gridcell"
              tabIndex={isCursor ? 0 : -1}
              data-cursor={isCursor}
              aria-selected={isSelected}
              aria-label={date}
              onClick={() => onPick(date)}
              className={`h-8 rounded-md text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-action-primary ${
                isSelected
                  ? "bg-brand-wash font-medium text-brand-primary"
                  : inMonth
                    ? "text-text-primary hover:bg-surface-well"
                    : "text-text-secondary/50 hover:bg-surface-well"
              }`}
            >
              {Number(day)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
