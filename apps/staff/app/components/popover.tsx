"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * A minimal trigger + floating panel (shared by the date picker, view switcher,
 * practitioner filter, and shortcuts list). Closes on outside-click and Escape;
 * returns focus to the trigger on close. No dependency — a handful of these beat
 * pulling in a popover library before shadcn lands (see the shell boundary note).
 */
export function Popover({
  trigger,
  align = "start",
  children,
}: {
  /** Renders the trigger; spread `props` onto the button (adds aria + ref wiring). */
  trigger: (props: {
    "aria-haspopup": "dialog";
    "aria-expanded": boolean;
    onClick: () => void;
    ref: React.Ref<HTMLButtonElement>;
  }) => React.ReactNode;
  align?: "start" | "end";
  /** Panel content; call `close` to dismiss (e.g. after a pick). */
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        setOpen(false); // outside click — no focus yank, the pointer already moved on
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <span className="relative inline-flex">
      {trigger({
        "aria-haspopup": "dialog",
        "aria-expanded": open,
        onClick: () => setOpen((v) => !v),
        ref: triggerRef,
      })}
      {open && (
        <div
          ref={panelRef}
          id={id}
          className={`absolute top-full z-50 mt-1.5 ${align === "end" ? "right-0" : "left-0"}`}
        >
          {children(close)}
        </div>
      )}
    </span>
  );
}
