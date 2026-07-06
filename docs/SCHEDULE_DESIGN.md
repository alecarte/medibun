# Staff Schedule design — locked decisions

**Status: APPROVED (Alec, 2026-07-06, via structured interview at the S5a UX review).
Binding for the staff Schedule surface.** Companion to DESIGN.md (quiet-tool register,
keyboard-first, undo-over-confirm all still apply). The S5a first cut shipped a functional
but UX-poor day sheet; this spec is the corrected experience.

## 1. Layout & scrolling

- The calendar card **fills the remaining viewport height**; the grid scrolls **inside** it.
- The grid spans the **full 24 hours** (Google-Calendar model). On load it auto-scrolls to
  ~1 hour before now when viewing today, or to the first appointment when viewing another
  day (fallback: practice opening hour).
- **Sticky inside the scroll container:** the practitioner (or weekday) header row and the
  time gutter. The toolbar sits above the scroll area and never scrolls away.
- The page header slims to kicker + "Schedule" title; date + appointment count live in the
  toolbar.

## 2. Toolbar (one row, attached to the top of the calendar card)

Left → right:

1. `‹` previous · **Today** · `›` next (period = day or week per the active view)
2. **Date button** — label like "Mon, Jul 6" (day) or "Jul 6 – 12" (week); opens the
   **popover mini-calendar**: a quiet month grid, arrow-key navigable, Enter picks,
   Escape closes. (Dot markers on days with appointments: later, needs a density endpoint.)
3. Appointment count ("10 appointments"), quiet text.

Right side:

4. **Practitioner filter** — week view only; defaults to the signed-in practitioner when
   they have a schedule, else the first practitioner (alphabetical).
5. **View dropdown** — Day · Week functional; **Month listed but "Soon"** (honest, not
   fake-clickable). Month is a per-day-density grid, its own pass + BFF range endpoint.
6. **Keyboard icon button** — opens the shortcuts popover.

## 3. Views

- **Day**: columns = practitioners (all at once — the S5 spec), rows = hours.
- **Week**: columns = **Mon–Sun** for **one practitioner** (the filter above). Blocks
  compress to time + patient name + status **dot** (full chips are too wide); clicking a
  block opens the same detail card. One fetch covers the whole week for all practitioners;
  the filter switches instantly client-side.
- **Month**: deferred (next pass). Reserved in the dropdown and the `M` key.
- **URL is the state**: `/schedule?view=week&date=YYYY-MM-DD&practitioner=<id>` — shareable,
  RSC-rendered, back/forward friendly. Invalid params degrade to defaults, never error.

## 4. Keyboard set (guarded: never fires while typing in an input)

`↑ ↓ ← →` move between blocks · `Enter` details · `C` check in · `Z` undo · `Esc` close ·
`T` today · `[` / `]` previous / next period · `D` / `W` switch view (`M` reserved) ·
`?` shortcuts popover.

## 5. Tooltips & shortcut discovery (replaces the old footer hint row)

- Every toolbar control gets a **quiet hover tooltip**: action name + its key in a `<kbd>`
  chip (e.g. "Next day · ]"). ~500 ms appearance delay. **Hover only — never on touch.**
- The **shortcuts popover** (keyboard icon, or `?`) lists the full set with `<kbd>` styling —
  the discoverability path on the front-desk tablet, where hover doesn't exist.

## 6. Non-goals of this pass

Month view · drag-to-reschedule (S5.5) · live updates & privacy mask (S5b) · appointment
creation from the calendar (staff booking arrives with S11's assistant, or its own slice).

## Review log

- 2026-07-06 — **Built** on the S5a branch: `ScheduleView` client component (viewport-fit card,
  internal 24 h scroll with sticky header + gutter, auto-scroll to now/first appointment),
  card toolbar (‹ Today › · date button → `MiniCalendar` popover · count · practitioner filter ·
  Day/Week dropdown with Month "Soon" · keyboard icon → `ShortcutsPopover`), week view (Mon–Sun ×
  one practitioner, compact dot blocks, client-side filter), full key set, and hover `Tooltip`s.
  BFF `GET /staff/schedule?days=1|7` Monday-aligns the week. Screenshot-reviewed at 1280 + tablet.
- 2026-07-06 — Interview-approved (Alec): viewport-fit 24 h internal scroll with auto-scroll;
  popover mini-calendar; Day + Week now with Month honestly "Soon"; week = 7 days × one
  practitioner, Monday start; toolbar on the card; tooltips + shortcuts popover with the
  full key set.
