import { tokens } from "@medibun/design-tokens";

const NAV_ITEMS = [
  { label: "Home", active: true },
  { label: "Book a visit", active: false },
  { label: "Your history", active: false },
  { label: "Ask", active: false },
] as const;

// The persistent app shell navigation. Items beyond Home activate as their slices land
// (booking S4, history S9, concierge S10) — shown as "Soon" until then, honestly.
export function Sidebar() {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border-hairline px-4 py-6">
      <span className="type-display px-3 text-xl text-text-primary">{tokens["brand-name"]}</span>

      <nav aria-label="Primary" className="mt-8 flex flex-1 flex-col gap-1">
        {NAV_ITEMS.map((item) => (
          <span
            key={item.label}
            aria-current={item.active ? "page" : undefined}
            className={
              item.active
                ? "flex items-center justify-between rounded-md bg-brand-wash px-3 py-2 text-sm font-medium text-brand-primary"
                : "flex items-center justify-between rounded-md px-3 py-2 text-sm text-text-secondary"
            }
          >
            {item.label}
            {!item.active && (
              <span className="rounded-full bg-surface-well px-2 py-0.5 text-xs">Soon</span>
            )}
          </span>
        ))}
      </nav>

      <span className="rounded-control bg-action-primary px-4 py-2 text-center text-sm font-medium text-text-on-accent">
        Sign in
      </span>
    </aside>
  );
}
