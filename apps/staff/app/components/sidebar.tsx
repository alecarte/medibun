"use client";

import { createApiClient } from "@medibun/api-client";
import { tokens } from "@medibun/design-tokens";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { COLLAPSE_COOKIE } from "../lib/prefs";
import {
  CalendarIcon,
  ChatIcon,
  CloseIcon,
  HomeIcon,
  MenuIcon,
  PanelIcon,
  UserIcon,
} from "./icons";

// The staff shell, in the quiet-tool register — same mechanics as the portal shell
// (collapsible icon rail, cookie-persisted server-first-paint state, ⌘/Ctrl+B toggle,
// fade-not-unmount labels, mobile top bar + drawer below md), ported at Alec's request
// 2026-07-04. Each app owns its shell for now; extraction waits for shadcn.
//
// ⌘/Ctrl+K is RESERVED for the staff command palette / assistant (S11).

// "Today" is the future staff DASHBOARD (events, follow-ups, radar — direction from the
// S5a review); the schedule is its own destination. Items without an href are honest
// "Soon" placeholders until their slices land (dashboard TBD, patients S7, assistant S11).
const NAV_ITEMS = [
  { label: "Today", icon: HomeIcon, href: undefined },
  { label: "Schedule", icon: CalendarIcon, href: "/schedule" },
  { label: "Patients", icon: UserIcon, href: undefined },
  { label: "Assistant", icon: ChatIcon, href: undefined },
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

function NavItems({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className="flex flex-1 flex-col gap-1">
      {NAV_ITEMS.map(({ label, icon: ItemIcon, href }) => {
        const active = href !== undefined && pathname.startsWith(href);
        const itemClass = `flex items-center gap-3 overflow-hidden rounded-md px-2.5 py-2 text-sm ${
          active
            ? "bg-brand-wash font-medium text-brand-primary"
            : "text-text-secondary" + (collapsed ? " opacity-50" : "")
        }`;
        if (href === undefined) {
          return (
            <span
              key={label}
              title={collapsed ? `${label} — soon` : undefined}
              className={itemClass}
            >
              <ItemIcon />
              <span className={`flex-1 ${labelClass(collapsed)}`}>{label}</span>
              <span
                className={`rounded-full bg-surface-well px-2 py-0.5 text-xs ${labelClass(collapsed)}`}
              >
                Soon
              </span>
            </span>
          );
        }
        return (
          <Link
            key={label}
            href={href}
            aria-current={active ? "page" : undefined}
            title={collapsed ? label : undefined}
            className={itemClass}
          >
            <ItemIcon />
            <span className={`flex-1 ${labelClass(collapsed)}`}>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/** Signed in: the staff member's identity + sign out. Signed out: the login link. */
function SessionFooter({ collapsed, staffName }: { collapsed: boolean; staffName?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  if (!staffName) {
    return (
      <Link
        href="/login"
        className="flex items-center justify-center gap-2 overflow-hidden rounded-control bg-action-primary px-2 py-2 text-sm font-medium text-text-on-accent"
      >
        <UserIcon />
        {!collapsed && <span className="whitespace-nowrap">Sign in</span>}
      </Link>
    );
  }

  async function onSignOut() {
    setPending(true);
    try {
      // Same-origin /api proxy; the BFF revokes the session and clears the cookie.
      await createApiClient({ baseUrl: "/api" }).logout();
    } catch {
      // Never strand the user on a failed logout call — navigate regardless; the
      // refreshed render reflects the actual session state.
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col gap-2 overflow-hidden">
      <span className="flex items-center gap-2 px-2.5 text-sm text-text-primary">
        <UserIcon />
        <span className={`min-w-0 truncate font-medium ${labelClass(collapsed)}`}>{staffName}</span>
      </span>
      <button
        type="button"
        onClick={() => void onSignOut()}
        disabled={pending}
        className={`rounded-control border border-border-interactive px-2 py-1.5 text-sm text-text-primary disabled:opacity-60 ${labelClass(collapsed)}`}
      >
        {pending ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}

export function Sidebar({
  initialCollapsed = false,
  staffName,
}: {
  initialCollapsed?: boolean;
  staffName?: string;
}) {
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
            <SessionFooter collapsed={false} staffName={staffName} />
          </div>
        </div>
      )}

      {/* Desktop shell (md+): the collapsible rail. */}
      <aside
        // Sticky full-viewport rail (differs from the portal shell deliberately): the
        // day sheet is viewport-tall by nature, and identity/sign-out must stay
        // reachable without scrolling past the whole calendar.
        className={`sticky top-0 hidden h-screen shrink-0 flex-col overflow-hidden border-r border-border-hairline px-3 py-5 md:flex ${ANIM} ${collapsed ? "w-16" : "w-56"}`}
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

        <SessionFooter collapsed={collapsed} staffName={staffName} />
      </aside>
    </>
  );
}
