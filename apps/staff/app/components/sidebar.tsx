"use client";

import { tokens } from "@medibun/design-tokens";
import { useEffect, useRef, useState } from "react";

import { COLLAPSE_COOKIE } from "../lib/prefs";
import { CalendarIcon, ChatIcon, CloseIcon, MenuIcon, PanelIcon, UserIcon } from "./icons";

// The staff shell, in the quiet-tool register — same mechanics as the portal shell
// (collapsible icon rail, cookie-persisted server-first-paint state, ⌘/Ctrl+B toggle,
// fade-not-unmount labels, mobile top bar + drawer below md), ported at Alec's request
// 2026-07-04. Each app owns its shell for now; extraction waits for shadcn.
//
// ⌘/Ctrl+K is RESERVED for the staff command palette / assistant (S11).

const NAV_ITEMS = [
  { label: "Today", icon: CalendarIcon, active: true },
  { label: "Patients", icon: UserIcon, active: false },
  { label: "Assistant", icon: ChatIcon, active: false },
] as const;

const ANIM =
  "motion-safe:transition-[width,height,top,opacity] motion-safe:duration-[var(--motion-duration-base)] motion-safe:ease-[var(--motion-easing-standard)]";

const labelClass = (collapsed: boolean) =>
  `whitespace-nowrap ${ANIM} ${collapsed ? "opacity-0" : "opacity-100"}`;

/** Brand icon mark (portal-identical fallback): the practice name's first letter on
 *  the brand theme color, until Practice Management logo assets exist. Decorative. */
function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`type-display flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-action-primary text-lg text-text-on-accent ${className ?? ""}`}
    >
      {tokens["brand-name"].charAt(0)}
    </span>
  );
}

function Wordmark() {
  return (
    <span className="text-sm text-text-secondary">
      <span className="type-display text-lg text-text-primary">{tokens["brand-name"]}</span>{" "}
      <span className="ml-1">Staff</span>
    </span>
  );
}

/** Items beyond Today activate as their slices land (patients with capture S7,
 *  assistant S11) — shown as "Soon" until then, honestly. */
function NavItems({ collapsed }: { collapsed: boolean }) {
  return (
    <nav aria-label="Primary" className="flex flex-1 flex-col gap-1">
      {NAV_ITEMS.map(({ label, icon: ItemIcon, active }) => (
        <span
          key={label}
          aria-current={active ? "page" : undefined}
          title={collapsed ? (active ? label : `${label} — soon`) : undefined}
          className={`flex items-center gap-3 overflow-hidden rounded-md px-2.5 py-2 text-sm ${
            active
              ? "bg-brand-wash font-medium text-brand-primary"
              : "text-text-secondary" + (collapsed ? " opacity-50" : "")
          }`}
        >
          <ItemIcon />
          <span className={`flex-1 ${labelClass(collapsed)}`}>{label}</span>
          {!active && (
            <span
              className={`rounded-full bg-surface-well px-2 py-0.5 text-xs ${labelClass(collapsed)}`}
            >
              Soon
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

/** Static until staff auth lands (S5) — then this becomes the login link/identity. */
function SignInFooter({ collapsed }: { collapsed: boolean }) {
  return (
    <span className="flex items-center justify-center gap-2 overflow-hidden rounded-control bg-action-primary px-2 py-2 text-sm font-medium text-text-on-accent">
      <UserIcon />
      {!collapsed && <span className="whitespace-nowrap">Sign in</span>}
    </span>
  );
}

export function Sidebar({ initialCollapsed = false }: { initialCollapsed?: boolean }) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const toggle = () => {
    const next = !collapsed;
    document.cookie = `${COLLAPSE_COOKIE}=${next ? "1" : "0"}; path=/; max-age=31536000; SameSite=Lax`;
    setCollapsed(next);
  };

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "b") {
        return;
      }
      if (event.shiftKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")
      ) {
        return;
      }
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  });

  useEffect(() => {
    if (!drawerOpen) {
      return;
    }
    closeButtonRef.current?.focus();
    document.body.style.overflow = "hidden";
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDrawerOpen(false);
      }
    };
    window.addEventListener("keydown", onEscape);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onEscape);
    };
  }, [drawerOpen]);

  return (
    <>
      {/* Mobile shell (<md): top bar + slide-over drawer (front desk on a tablet). */}
      <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-border-hairline bg-surface-canvas px-4 py-2.5 md:hidden">
        <span className="flex items-center gap-2.5">
          <BrandMark className="h-8 w-8 text-base" />
          <Wordmark />
        </span>
        <button
          type="button"
          aria-label="Open menu"
          onClick={() => setDrawerOpen(true)}
          className="rounded-md p-2 text-text-secondary hover:bg-surface-well"
        >
          <MenuIcon />
        </button>
      </header>
      {drawerOpen && (
        <div className="fixed inset-0 z-30 md:hidden">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-text-primary/30"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col gap-8 border-r border-border-hairline bg-surface-canvas px-4 py-4"
          >
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2.5">
                <BrandMark className="h-8 w-8 text-base" />
                <Wordmark />
              </span>
              <button
                ref={closeButtonRef}
                type="button"
                aria-label="Close menu"
                onClick={() => setDrawerOpen(false)}
                className="rounded-md p-2 text-text-secondary hover:bg-surface-well"
              >
                <CloseIcon />
              </button>
            </div>
            <NavItems collapsed={false} />
            <SignInFooter collapsed={false} />
          </div>
        </div>
      )}

      {/* Desktop shell (md+): the collapsible rail. */}
      <aside
        className={`hidden shrink-0 flex-col overflow-hidden border-r border-border-hairline px-3 py-5 md:flex ${ANIM} ${collapsed ? "w-16" : "w-56"}`}
      >
        <div className={`relative shrink-0 ${ANIM} ${collapsed ? "h-[5.25rem]" : "h-10"}`}>
          <span className="flex h-10 items-center">
            <BrandMark
              className={`absolute top-0 left-0 ${ANIM} ${collapsed ? "opacity-100" : "opacity-0"}`}
            />
            <span className={`px-2.5 ${labelClass(collapsed)}`}>
              <Wordmark />
            </span>
          </span>
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-keyshortcuts="Control+B Meta+B"
            title={collapsed ? "Expand sidebar (⌘B)" : "Collapse sidebar (⌘B)"}
            onClick={toggle}
            className={`absolute right-0 rounded-md p-2 text-text-secondary hover:bg-surface-well ${ANIM} ${collapsed ? "top-11" : "top-0"}`}
          >
            <PanelIcon />
          </button>
        </div>

        <div className="mt-7 flex flex-1 flex-col">
          <NavItems collapsed={collapsed} />
        </div>

        <SignInFooter collapsed={collapsed} />
      </aside>
    </>
  );
}
