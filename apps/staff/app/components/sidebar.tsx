import { tokens } from "@medibun/design-tokens";

const NAV_ITEMS = [
  { label: "Today", active: true },
  { label: "Patients", active: false },
  { label: "Assistant", active: false },
] as const;

// The persistent staff app shell navigation. Items beyond Today activate as their slices
// land (patients with capture S7, assistant S11) — shown as "Soon" until then, honestly.
export function Sidebar() {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border-hairline px-3 py-5">
      <span className="px-3 text-sm text-text-secondary">
        <span className="type-display text-lg text-text-primary">{tokens["brand-name"]}</span>{" "}
        <span className="ml-1">Staff</span>
      </span>

      <nav aria-label="Primary" className="mt-7 flex flex-1 flex-col gap-1">
        {NAV_ITEMS.map((item) => (
          <span
            key={item.label}
            aria-current={item.active ? "page" : undefined}
            className={
              item.active
                ? "flex items-center justify-between rounded-md bg-brand-wash px-3 py-1.5 text-sm font-medium text-brand-primary"
                : "flex items-center justify-between rounded-md px-3 py-1.5 text-sm text-text-secondary"
            }
          >
            {item.label}
            {!item.active && (
              <span className="rounded-full bg-surface-well px-2 py-0.5 text-xs">Soon</span>
            )}
          </span>
        ))}
      </nav>

      <span className="rounded-control bg-action-primary px-4 py-1.5 text-center text-sm font-medium text-text-on-accent">
        Sign in
      </span>
    </aside>
  );
}
