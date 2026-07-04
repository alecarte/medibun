"use client";

import { tokens } from "@medibun/design-tokens";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { COLLAPSE_COOKIE } from "../lib/prefs";
import { formatPrice } from "../lib/slots";
import { Avatar } from "./avatar";
import {
  CalendarPlusIcon,
  ChatIcon,
  CloseIcon,
  HistoryIcon,
  HomeIcon,
  MenuIcon,
  PanelIcon,
  UserIcon,
  WalletIcon,
} from "./icons";

// Collapse preference rides a cookie (lib/prefs.ts), not localStorage: the server
// layout renders the collapsed state on the first paint (no post-hydration flash or
// layout shift) and document.cookie never throws where storage is blocked.
//
// Animation discipline (how the leading tools do it): the collapsed rail is a CLIPPED
// VIEW of the expanded layout, not a different layout. Icons keep the same x-position
// in both states, labels never re-wrap (nowrap) — they fade and get clipped by the
// width transition — and nothing mounts/unmounts mid-animation, so text can't judder.
// Transitions are motion-safe only and ride the motion tokens.
//
// Mobile-first (binding, DESIGN.md): below md the rail is replaced by a top bar plus a
// slide-over drawer carrying the same navigation — a 240px rail has no business on a
// phone. The drawer unmounts when closed (no hidden-but-tabbable tree).

// Wallet credits arrive with the commerce phase (BOOKING_DESIGN.md shell spec); until
// then the truthful balance of a not-yet-existing wallet is zero. One constant to
// replace with the experience-DB value — never a faked demo number.
const WALLET_BALANCE_CENTS = 0;

const ANIM =
  "motion-safe:transition-[width,height,top,opacity] motion-safe:duration-[var(--motion-duration-base)] motion-safe:ease-[var(--motion-easing-standard)]";

/** Labels fade + clip instead of unmounting: no reflow, and their accessible names
 *  survive in both states (so collapsed links need no aria-label duplicates). */
const labelClass = (collapsed: boolean) =>
  `whitespace-nowrap ${ANIM} ${collapsed ? "opacity-0" : "opacity-100"}`;

const itemClass = (active: boolean) =>
  `flex items-center gap-3 overflow-hidden rounded-md px-2.5 py-2 text-sm ${
    active ? "bg-brand-wash font-medium text-brand-primary" : "text-text-secondary"
  }`;

/** The brand's icon mark — the seam for practice-swappable logo assets (Practice
 *  Management settings, later). With no icon asset the fallback is the practice
 *  name's first letter on the brand theme color. Decorative: the wordmark carries
 *  the accessible name wherever the mark appears. */
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

/** One nav tree for every shell surface (rail, drawer). `collapsed` is only ever true
 *  in the rail; the drawer renders expanded and closes itself via `onNavigate`. */
function NavItems({
  signedIn,
  collapsed,
  onNavigate,
}: {
  signedIn: boolean;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const links = [
    { label: "Home", href: "/", icon: HomeIcon, active: pathname === "/" },
    {
      label: "Book a visit",
      href: "/book",
      icon: CalendarPlusIcon,
      active: pathname.startsWith("/book"),
    },
    ...(signedIn
      ? [
          {
            label: "Your account",
            href: "/account",
            icon: UserIcon,
            active: pathname === "/account",
          },
        ]
      : []),
  ];
  const comingSoon = [
    { label: "Your history", icon: HistoryIcon },
    { label: "Ask", icon: ChatIcon },
  ];

  return (
    <nav aria-label="Primary" className="flex flex-1 flex-col gap-1">
      {links.map(({ label, href, icon: ItemIcon, active }) => (
        <Link
          key={href}
          href={href}
          aria-current={active ? "page" : undefined}
          title={collapsed ? label : undefined}
          onClick={onNavigate}
          className={itemClass(active)}
        >
          <ItemIcon />
          <span className={`flex-1 ${labelClass(collapsed)}`}>{label}</span>
        </Link>
      ))}
      {comingSoon.map(({ label, icon: ItemIcon }) => (
        // Real text in both states (faded when collapsed) — generic spans can't carry
        // aria-labels, and the honest "Soon" must survive in the accessibility tree.
        <span
          key={label}
          title={collapsed ? `${label} — soon` : undefined}
          className={`${itemClass(false)} ${collapsed ? "opacity-50" : ""}`}
        >
          <ItemIcon />
          <span className={`flex-1 ${labelClass(collapsed)}`}>{label}</span>
          <span
            className={`rounded-full bg-surface-well px-2 py-0.5 text-xs ${labelClass(collapsed)}`}
          >
            Soon
          </span>
        </span>
      ))}
    </nav>
  );
}

/** The shell identity block (V0_PROPOSAL §6 rev. 3): generated avatar + wallet balance
 *  now; membership/loyalty status joins when commerce delivers real data. */
function ProfileFooter({
  profileName,
  collapsed,
  onNavigate,
}: {
  profileName?: string;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  return profileName ? (
    <Link
      href="/account"
      aria-label={collapsed ? profileName : undefined}
      title={collapsed ? profileName : undefined}
      onClick={onNavigate}
      className={`flex items-center gap-3 overflow-hidden rounded-control border p-1 text-sm text-text-secondary ${ANIM} ${
        collapsed ? "border-transparent" : "border-border-hairline"
      }`}
    >
      <Avatar name={profileName} />
      <span className={`min-w-0 ${labelClass(collapsed)}`}>
        <span className="block truncate font-medium text-text-primary">{profileName}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-xs">
          <WalletIcon className="h-3.5 w-3.5" />
          <span className="tabular-nums">{formatPrice(WALLET_BALANCE_CENTS)}</span>
        </span>
      </span>
    </Link>
  ) : (
    <Link
      href="/login"
      aria-label="Sign in"
      title={collapsed ? "Sign in" : undefined}
      onClick={onNavigate}
      className="flex items-center justify-center gap-2 overflow-hidden rounded-control bg-action-primary px-2 py-2 text-sm font-medium text-text-on-accent"
    >
      <UserIcon />
      {!collapsed && <span className="whitespace-nowrap">Sign in</span>}
    </Link>
  );
}

// The persistent app shell navigation. Items activate as their slices land (booking
// landed with S4; history S9, concierge S10) — shown as "Soon" until then.
// Keyboard: ⌘/Ctrl+B toggles the sidebar (the shadcn/VS Code convention).
// ⌘/Ctrl+K is RESERVED for search/concierge (patient portal S10; staff palette S11).
export function Sidebar({
  profileName,
  initialCollapsed = false,
}: {
  profileName?: string;
  /** Server-read cookie value, so the first paint is already in the right state. */
  initialCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const toggle = () => {
    const next = !collapsed;
    // Side effect in the handler, never in the state updater (updaters must be pure).
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

  // Drawer housekeeping: Escape closes, the page behind doesn't scroll, and focus
  // lands on the close button so keyboard/screen-reader users arrive inside it.
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

  const closeDrawer = () => setDrawerOpen(false);

  return (
    <>
      {/* Mobile shell (<md): top bar + slide-over drawer. */}
      <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-border-hairline bg-surface-canvas px-4 py-2.5 md:hidden">
        <Link href="/" className="flex items-center gap-2.5">
          <BrandMark className="h-8 w-8 text-base" />
          <span className="type-display text-lg text-text-primary">{tokens["brand-name"]}</span>
        </Link>
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
            onClick={closeDrawer}
            className="absolute inset-0 bg-text-primary/30"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col gap-8 border-r border-border-hairline bg-surface-canvas px-4 py-4"
          >
            <div className="flex items-center justify-between">
              <Link href="/" onClick={closeDrawer} className="flex items-center gap-2.5">
                <BrandMark className="h-8 w-8 text-base" />
                <span className="type-display text-lg text-text-primary">
                  {tokens["brand-name"]}
                </span>
              </Link>
              <button
                ref={closeButtonRef}
                type="button"
                aria-label="Close menu"
                onClick={closeDrawer}
                className="rounded-md p-2 text-text-secondary hover:bg-surface-well"
              >
                <CloseIcon />
              </button>
            </div>
            <NavItems signedIn={!!profileName} collapsed={false} onNavigate={closeDrawer} />
            <ProfileFooter profileName={profileName} collapsed={false} onNavigate={closeDrawer} />
          </div>
        </div>
      )}

      {/* Desktop shell (md+): the collapsible rail. */}
      <aside
        className={`hidden shrink-0 flex-col overflow-hidden border-r border-border-hairline px-3 py-6 md:flex ${ANIM} ${collapsed ? "w-16" : "w-60"}`}
      >
        {/* Two 40px controls can't share the collapsed rail's 40px row, so the header
            animates between one row (wordmark + toggle at right) and a stacked column
            (brand icon, toggle beneath). Logotype expanded, icon mark collapsed. */}
        <div className={`relative shrink-0 ${ANIM} ${collapsed ? "h-[5.25rem]" : "h-10"}`}>
          <Link href="/" className="flex h-10 items-center">
            <BrandMark
              className={`absolute top-0 left-0 ${ANIM} ${collapsed ? "opacity-100" : "opacity-0"}`}
            />
            <span
              className={`type-display px-2.5 text-xl text-text-primary ${labelClass(collapsed)}`}
            >
              {tokens["brand-name"]}
            </span>
          </Link>
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

        <div className="mt-8 flex flex-1 flex-col">
          <NavItems signedIn={!!profileName} collapsed={collapsed} />
        </div>

        <ProfileFooter profileName={profileName} collapsed={collapsed} />
      </aside>
    </>
  );
}
