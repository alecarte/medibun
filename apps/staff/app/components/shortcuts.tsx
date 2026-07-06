"use client";

import { useEffect, useRef } from "react";

/**
 * The keyboard-shortcut reference (SCHEDULE_DESIGN.md §5) — the discovery path on the
 * front-desk tablet where hover tooltips don't exist. One source of truth for the set;
 * the day-sheet's key handler and the toolbar tooltips read the same names.
 */
export const SHORTCUTS: readonly { keys: string; label: string }[] = [
  { keys: "← → ↑ ↓", label: "Move between appointments" },
  { keys: "Enter", label: "Open appointment details" },
  { keys: "C", label: "Check in the focused appointment" },
  { keys: "Z", label: "Undo the last change" },
  { keys: "T", label: "Jump to today" },
  { keys: "[ ]", label: "Previous / next day or week" },
  { keys: "D W", label: "Switch to day / week view" },
  { keys: "?", label: "Show this shortcuts list" },
  { keys: "Esc", label: "Close a panel" },
];

export function ShortcutsPopover({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Keyboard shortcuts"
      tabIndex={-1}
      className="w-72 rounded-lg border border-border-hairline bg-surface-card p-4 shadow-lg outline-none"
    >
      <p className="mb-2 text-sm font-medium text-text-primary">Keyboard shortcuts</p>
      <dl className="flex flex-col gap-1.5">
        {SHORTCUTS.map(({ keys, label }) => (
          <div key={keys} className="flex items-center justify-between gap-4">
            <dt className="text-sm text-text-secondary">{label}</dt>
            <dd className="flex shrink-0 gap-1">
              {keys.split(" ").map((k) => (
                <kbd
                  key={k}
                  className="rounded border border-border-hairline bg-surface-well px-1.5 py-0.5 font-mono text-[11px] text-text-primary"
                >
                  {k}
                </kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
