"use client";

import { tokens } from "@medibun/design-tokens";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

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
// layout shift) and document.cookie never throws where storage is blocked (review fixes).

// Wallet credits arrive with the commerce phase (BOOKING_DESIGN.md shell spec); until
// then the truthful balance of a not-yet-existing wallet is zero. One constant to
// replace with the experience-DB value — never a faked demo number.
const WALLET_BALANCE_CENTS = 0;

const itemClass = (active: boolean, collapsed: boolean) =>
  `flex items-center rounded-md text-sm ${collapsed ? "justify-center px-2 py-2" : "gap-3 px-3 py-2"} ${
    active ? "bg-brand-wash font-medium text-brand-primary" : "text-text-secondary"
  }`;

// The persistent app shell navigation. Items activate as their slices land (booking
// landed with S4; history S9, concierge S10) — shown as "Soon" until then.
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
      className={`flex shrink-0 flex-col border-r border-border-hairline py-6 ${collapsed ? "w-16 px-2" : "w-60 px-4"}`}
      style={{
        transition: "width var(--motion-duration-base) var(--motion-easing-standard)",
      }}
    >
      <div className={`flex items-center ${collapsed ? "justify-center" : "justify-between px-3"}`}>
        {!collapsed && (
          <Link href="/" className="type-display text-xl text-text-primary">
            {tokens["brand-name"]}
          </Link>
        )}
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={toggle}
          className="rounded-md p-1.5 text-text-secondary hover:bg-surface-well"
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
            aria-label={label}
            title={collapsed ? label : undefined}
            className={itemClass(active, collapsed)}
          >
            <ItemIcon />
            {!collapsed && <span className="flex-1">{label}</span>}
          </Link>
        ))}
        {comingSoon.map(({ label, icon: ItemIcon }) => (
          // Plain content, no aria-label: generic spans are name-prohibited, so the
          // label lives in (visually hidden) text and the "soon" honesty survives in
          // the accessibility tree in both states (review fix).
          <span
            key={label}
            title={collapsed ? `${label} — soon` : undefined}
            className={`${itemClass(false, collapsed)} ${collapsed ? "opacity-50" : ""}`}
          >
            <ItemIcon />
            {collapsed ? (
              <span className="sr-only">{label} — soon</span>
            ) : (
              <>
                <span className="flex-1">{label}</span>
                <span className="rounded-full bg-surface-well px-2 py-0.5 text-xs">Soon</span>
              </>
            )}
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
          className={`flex items-center rounded-control border border-border-hairline text-sm text-text-secondary ${
            collapsed ? "justify-center border-transparent p-1" : "gap-3 px-3 py-2"
          }`}
        >
          <Avatar name={profileName} />
          {!collapsed && (
            <span className="min-w-0">
              <span className="block truncate font-medium text-text-primary">{profileName}</span>
              <span className="mt-0.5 flex items-center gap-1.5 text-xs">
                <WalletIcon className="h-3.5 w-3.5" />
                <span className="tabular-nums">{formatPrice(WALLET_BALANCE_CENTS)}</span>
              </span>
            </span>
          )}
        </Link>
      ) : (
        <Link
          href="/login"
          aria-label="Sign in"
          title={collapsed ? "Sign in" : undefined}
          className={`rounded-control bg-action-primary text-center text-sm font-medium text-text-on-accent ${
            collapsed ? "flex justify-center p-2" : "px-4 py-2"
          }`}
        >
          {collapsed ? <UserIcon /> : "Sign in"}
        </Link>
      )}
    </aside>
  );
}
