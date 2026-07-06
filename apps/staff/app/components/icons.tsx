/**
 * Minimal line icons for the shell (hand-drawn, stroke=currentColor — no icon
 * dependency for a handful of glyphs). 24px grid, 1.5px stroke, round caps: the
 * refined-schematic register from DESIGN.md. Mirrors the portal's set (each app owns
 * its shell; extraction into a shared package waits for shadcn/lucide — see the
 * boundary note in the portal's icons.tsx).
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

export function CalendarIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect x="4" y="5.5" width="16" height="14.5" rx="2" />
      <path d="M4 10h16" />
      <path d="M8 3.5v3M16 3.5v3" />
    </Icon>
  );
}

export function HomeIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M4.5 10.5 12 4l7.5 6.5" />
      <path d="M6.5 9v9.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V9" />
      <path d="M10 19.5v-5h4v5" />
    </Icon>
  );
}

export function ChevronLeftIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M14.5 6 8.5 12l6 6" />
    </Icon>
  );
}

export function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M9.5 6l6 6-6 6" />
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

export function ChatIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H9l-4.2 3.2c-.4.3-.8 0-.8-.4z" />
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

export function KeyboardIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect x="3" y="6.5" width="18" height="11" rx="2" />
      <path d="M7 10h.01M10.5 10h.01M14 10h.01M17 10h.01M8.5 13.5h7" />
    </Icon>
  );
}

export function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M6 9.5l6 6 6-6" />
    </Icon>
  );
}

export function MenuIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Icon>
  );
}

export function EyeIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M3.5 12S6.5 6.5 12 6.5 20.5 12 20.5 12 17.5 17.5 12 17.5 3.5 12 3.5 12z" />
      <circle cx="12" cy="12" r="2.5" />
    </Icon>
  );
}

export function EyeOffIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M3.5 12S6.5 6.5 12 6.5c1.6 0 3 .5 4.2 1.2M20.5 12s-3 5.5-8.5 5.5c-1.6 0-3-.5-4.2-1.2" />
      <path d="M9.9 14.1a2.9 2.9 0 0 1 4.2-4.2" />
      <path d="M5 19 19 5" />
    </Icon>
  );
}

export function CloseIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Icon>
  );
}
