"use client";

import { tokens } from "@medibun/design-tokens";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { COLLAPSE_COOKIE } from "../lib/prefs";
import { formatPrice } from "../lib/slots";
import { Avatar } from "./avatar";
import {
  CalendarPlusIcon,
  ChatIcon,
  HistoryIcon,
  HomeIcon,
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

// Wallet credits arrive with the commerce phase (BOOKING_DESIGN.md shell spec); until
// then the truthful balance of a not-yet-existing wallet is zero. One constant to
// replace with the experience-DB value — never a faked demo number.
const WALLET_BALANCE_CENTS = 0;

const ANIM =
  "motion-safe:transition-[width,opacity] motion-safe:duration-[var(--motion-duration-base)] motion-safe:ease-[var(--motion-easing-standard)]";

/** Labels fade + clip instead of unmounting: no reflow, and their accessible names
 *  survive in both states (so collapsed links need no aria-label duplicates). */
const labelClass = (collapsed: boolean) =>
  `whitespace-nowrap ${ANIM} ${collapsed ? "opacity-0" : "opacity-100"}`;

const itemClass = (active: boolean) =>
  `flex items-center gap-3 overflow-hidden rounded-md px-2.5 py-2 text-sm ${
    active ? "bg-brand-wash font-medium text-brand-primary" : "text-text-secondary"
  }`;

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
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(initialCollapsed);
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

  const links = [
    { label: "Home", href: "/", icon: HomeIcon, active: pathname === "/" },
    {
      label: "Book a visit",
      href: "/book",
      icon: CalendarPlusIcon,
      active: pathname.startsWith("/book"),
    },
    ...(profileName
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
    <aside
      className={`flex shrink-0 flex-col overflow-hidden border-r border-border-hairline px-3 py-6 ${ANIM} ${collapsed ? "w-16" : "w-60"}`}
    >
      <div className="flex items-center overflow-hidden">
        <Link
          href="/"
          tabIndex={collapsed ? -1 : 0}
          className={`type-display min-w-0 flex-1 px-2.5 text-xl text-text-primary ${labelClass(collapsed)}`}
        >
          {tokens["brand-name"]}
        </Link>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-keyshortcuts="Control+B Meta+B"
          title={collapsed ? "Expand sidebar (⌘B)" : "Collapse sidebar (⌘B)"}
          onClick={toggle}
          className="shrink-0 rounded-md p-2.5 text-text-secondary hover:bg-surface-well"
        >
          <PanelIcon />
        </button>
      </div>

      <nav aria-label="Primary" className="mt-8 flex flex-1 flex-col gap-1">
        {links.map(({ label, href, icon: ItemIcon, active }) => (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            title={collapsed ? label : undefined}
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

      {profileName ? (
        // The shell identity block (V0_PROPOSAL §6 rev. 3): generated avatar + wallet
        // balance now; membership/loyalty status joins when commerce delivers real data.
        <Link
          href="/account"
          aria-label={collapsed ? profileName : undefined}
          title={collapsed ? profileName : undefined}
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
          className="flex items-center justify-center gap-2 overflow-hidden rounded-control bg-action-primary px-2 py-2 text-sm font-medium text-text-on-accent"
        >
          <UserIcon />
          {!collapsed && <span className="whitespace-nowrap">Sign in</span>}
        </Link>
      )}
    </aside>
  );
}
