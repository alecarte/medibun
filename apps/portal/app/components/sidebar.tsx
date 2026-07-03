"use client";

import { tokens } from "@medibun/design-tokens";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Avatar } from "./avatar";

const COMING_SOON = ["Your history", "Ask"] as const;

const itemClass = (active: boolean) =>
  active
    ? "flex items-center justify-between rounded-md bg-brand-wash px-3 py-2 text-sm font-medium text-brand-primary"
    : "flex items-center justify-between rounded-md px-3 py-2 text-sm text-text-secondary";

// The persistent app shell navigation. Items activate as their slices land (booking
// landed with S4; history S9, concierge S10) — shown as "Soon" until then.
export function Sidebar({ profileName }: { profileName?: string }) {
  const pathname = usePathname();
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border-hairline px-4 py-6">
      <Link href="/" className="type-display px-3 text-xl text-text-primary">
        {tokens["brand-name"]}
      </Link>

      <nav aria-label="Primary" className="mt-8 flex flex-1 flex-col gap-1">
        <Link
          href="/"
          aria-current={pathname === "/" ? "page" : undefined}
          className={itemClass(pathname === "/")}
        >
          Home
        </Link>
        <Link
          href="/book"
          aria-current={pathname.startsWith("/book") ? "page" : undefined}
          className={itemClass(pathname.startsWith("/book"))}
        >
          Book a visit
        </Link>
        {profileName && (
          <Link
            href="/account"
            aria-current={pathname === "/account" ? "page" : undefined}
            className={itemClass(pathname === "/account")}
          >
            Your account
          </Link>
        )}
        {COMING_SOON.map((label) => (
          <span key={label} className={itemClass(false)}>
            {label}
            <span className="rounded-full bg-surface-well px-2 py-0.5 text-xs">Soon</span>
          </span>
        ))}
      </nav>

      {profileName ? (
        // The shell identity block (V0_PROPOSAL §6 rev. 3): generated avatar now; wallet
        // balance + membership/loyalty status render here once the commerce phase
        // delivers real experience data — placement is reserved, nothing is faked.
        <Link
          href="/account"
          className="flex items-center gap-3 rounded-control border border-border-hairline px-3 py-2 text-left text-sm text-text-secondary"
        >
          <Avatar name={profileName} />
          <span className="min-w-0">
            <span className="block truncate font-medium text-text-primary">{profileName}</span>
            <span className="block text-xs">Your account</span>
          </span>
        </Link>
      ) : (
        <Link
          href="/login"
          className="rounded-control bg-action-primary px-4 py-2 text-center text-sm font-medium text-text-on-accent"
        >
          Sign in
        </Link>
      )}
    </aside>
  );
}
