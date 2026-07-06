"use client";

import { useId, useRef, useState } from "react";

/**
 * A quiet hover/focus tooltip (DESIGN.md quiet-tool register). Names an action and,
 * optionally, its keyboard shortcut in a <kbd> chip. Hover only appears after a delay,
 * and NEVER on touch (front-desk tablet — pointer:coarse gets no tooltip, the shortcuts
 * popover is the discovery path there). Keyboard focus shows it immediately (a11y).
 */
export function Tooltip({
  label,
  shortcut,
  children,
}: {
  label: string;
  shortcut?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();

  const show = (delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setOpen(false);
  };

  return (
    <span
      className="relative inline-flex"
      // Touch devices fire pointerenter with pointerType "touch" right before click —
      // ignore those so a tap never leaves a tooltip stuck open.
      onPointerEnter={(e) => e.pointerType === "mouse" && show(500)}
      onPointerLeave={hide}
      onFocus={() => show(0)}
      onBlur={hide}
    >
      {/* Describe, don't label: the control keeps its own aria-label. */}
      <span aria-describedby={open ? id : undefined} className="inline-flex">
        {children}
      </span>
      {open && (
        <span
          role="tooltip"
          id={id}
          className="pointer-events-none absolute top-full left-1/2 z-50 mt-1.5 flex -translate-x-1/2 items-center gap-1.5 rounded-control bg-text-primary px-2 py-1 text-xs whitespace-nowrap text-surface-canvas shadow-lg"
        >
          {label}
          {shortcut && (
            <kbd className="rounded border border-surface-canvas/30 px-1 font-mono text-[10px]">
              {shortcut}
            </kbd>
          )}
        </span>
      )}
    </span>
  );
}
