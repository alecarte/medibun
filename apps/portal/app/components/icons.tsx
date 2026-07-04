/**
 * Minimal line icons for the shell (hand-drawn, stroke=currentColor — no icon
 * dependency for a handful of glyphs). 24px grid, 1.5px stroke, round caps: the
 * refined-schematic register from DESIGN.md.
 *
 * Boundary (decided at S4.5 review): hand-rolled icons are for the SHELL only. The
 * moment shadcn components (which ship lucide) land, new icons come from lucide at a
 * matched stroke weight — don't grow a parallel icon system here.
 */

function Icon({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-5 w-5 shrink-0 ${className ?? ""}`}
    >
      {children}
    </svg>
  );
}

export function HomeIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M4 10.5 12 4l8 6.5" />
      <path d="M6 9.5V20h12V9.5" />
      <path d="M10 20v-5h4v5" />
    </Icon>
  );
}

export function CalendarPlusIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect x="4" y="5.5" width="16" height="14.5" rx="2" />
      <path d="M4 10h16" />
      <path d="M8 3.5v3M16 3.5v3" />
      <path d="M12 12.5v4M10 14.5h4" />
    </Icon>
  );
}

export function UserIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="8.5" r="3.25" />
      <path d="M5.5 19.5c1.2-3 3.7-4.5 6.5-4.5s5.3 1.5 6.5 4.5" />
    </Icon>
  );
}

export function HistoryIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 2" />
    </Icon>
  );
}

export function ChatIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H9l-4.2 3.2c-.4.3-.8 0-.8-.4z" />
    </Icon>
  );
}

export function WalletIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect x="3.5" y="6" width="17" height="13" rx="2" />
      <path d="M3.5 9.5h17" />
      <path d="M15.5 14.5h2" />
    </Icon>
  );
}

export function PanelIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9.5 4.5v15" />
    </Icon>
  );
}
