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

Month view · drag-to-reschedule (S5.5) · appointment creation from the calendar (staff
booking arrives with S11's assistant, or its own slice). ~~Live updates & privacy mask~~
— shipped by S5b, see §7.

## 7. S5b — privacy glance mask + live updates (APPROVED Alec 2026-07-06, shipped)

- **Privacy glance mask**: patient names render as **initials** ("S. L.") in day and week
  blocks, the detail card, the undo toast, and accessible names; the detail card's
  phone/email/booked-at read **"Hidden"** while masked (missing values keep their em dash).
  Practitioners, services, times, statuses, and counts stay visible — the desk still works.
- Toggle = toolbar **eye button** (active = brand wash, crossed-out eye) or **`P`**. The
  mask **auto-engages after 2 minutes idle** (`IDLE_MASK_MS`, `lib/privacy.ts`) — the
  incidental-disclosure safeguard for walk-behind moments (COMPETITIVE_NOTES §2).
- **Unmasking is one tap / keypress — the session is never touched** (decided over
  re-auth-to-unmask, which arrives with post-v0 real-staff hardening; see AUTH.md).
- Seam: the idle auto-engage lives in `ScheduleView` because the Schedule is the only
  staff PHI surface today — when more land, hoist mask + idle to a shell-level provider
  rather than re-implementing per page (security-review observation, 2026-07-06).
- **Live updates**: the schedule reflects other stations' changes with **no manual
  refresh** — a quiet RSC refetch every 15s (`POLL_INTERVAL_MS`) while the tab is
  visible, a catch-up refetch when the tab becomes visible again, paused while a status
  write is in flight (no optimistic flicker). Background refetches keep scroll position;
  only a real navigation (view/date/filter change) re-runs the auto-scroll. Chosen over
  SSE/Subscriptions push for v0 (no new infra, reads stay on the staff user's own
  principal); the Subscriptions-driven upgrade is the documented seam.

## 8. S5c — internal events (APPROVED Alec 2026-07-06, shipped; amended same day)

- **Two types**: meeting (1+ practitioners) · misc block (one practitioner). **Time off
  is not a category** (amendment, Alec 2026-07-06): it's a **titled block** — "PTO",
  "Time away" — either **all-day** or **timed (half-days)**. Any event can be all-day.
  Recurrence and weekly templates stay post-v0.
- **Create**: toolbar **New** button or **`N`** → a quiet form popover (type · title —
  the PTO tag lives here, placeholder suggests it · practitioner pick · date · **All day
  toggle** or times). Everything practice-local; the BFF owns timezone math. Title
  microcopy states the non-PHI rule (titles render unmasked). Every disabled-Add reason
  is said out loud: no schedules yet → explanatory panel; nothing picked → "Pick at
  least one practitioner."; inverted times → "End time must be after the start."
  (front-desk feedback 2026-07-06 — a greyed button with no explanation is a dead end).
- **Render**: muted dashed blocks (surface-well wash, secondary text) behind appointment
  blocks in every affected column; a full-practice-day window reads "All day" (detected
  from wall times — no flag on the wire). Events don't join the appointment count or the
  arrow-key cursor, and they stay visible under the privacy mask (no PHI by
  construction).
- **Delete**: from the event's detail card, immediate with the standard ~10s undo; undo of
  a create deletes, undo of a delete recreates (compensating, like the status workflow).
  No editing-in-place — delete + recreate.
- Data model + endpoints: DATA_MODEL.md "Internal events", API.md `/staff/events`.

## 9. Queue after S5c (4D-gap pull-forward — Alec 2026-07-06, sequencing delegated)

1. **Overlap layout — shipped same day** (defect-class): overlapping appointments in one
   column cluster into side-by-side lanes (greedy lane reuse; solo blocks keep the full
   width). Prerequisite for drag — dropping onto occupied space creates overlaps.
2. **S5.5 drag-to-reschedule** — shipped, see §10.
3. **S5.7 move-up list — shipped, see §11** (interview-approved + built 2026-07-09).
4. **S5.8 room/resource columns** — rooms as first-class calendars ("OR 2"). Direction:
   rooms are `Location` resources with their own Schedules (FHIR allows a Location actor;
   **verify `$find` accepts non-Practitioner actors against the v5.1.9 source at build
   time**), appointments carry the room as a participant. **FHIR data-model amendment,
   approval-gated** (ask-before-modeling). Pre-Handal-migration requirement (surgical
   practices schedule rooms), not Aureva-demo-critical.

Smaller 4D items keep their noted homes (COMPETITIVE_NOTES §6): calendar visibility
toggles, jump-ahead nav, a plain Find-Openings affordance alongside S11, grid zoom.

## 10. S5.5 — drag-to-reschedule (interview-approved Alec 2026-07-06, shipped)

- **Mechanics**: patch + slot swap, identity-preserving (no `$reschedule` exists at our
  pin). The BFF re-derives the target window is free against busy Slots, creates the new
  protector slot, test-and-sets the Appointment's start (concurrent moves lose cleanly),
  deletes the old slot. Reads + the patch run as the caller; slot writes ride the service
  client. Availability _hours_ deliberately unchecked — off-hours squeeze-ins are staff
  judgment; conflicts are what matter.
- **Scope**: day view, time and/or practitioner column (target must offer the service).
  **Scheduled blocks only** — others don't lift. **15-minute snap**, duration preserved.
- **Interaction**: mouse press + ~6px travel lifts the block (a plain press stays a
  click); a dashed ghost previews the snapped landing window with its time; `Esc`
  cancels; drop executes immediately with the standard ~10s undo (a compensating reverse
  move — which can itself hit a 409 if the old window got taken, surfaced honestly).
  A 409 on drop explains and refreshes, never clobbers.
- **Queued follow-ups**: touch drag (a finger on a block must keep scrolling the grid —
  needs a long-press affordance) · keyboard reschedule (via the detail card) · week-view
  drag (single-practitioner columns make it a date move — different interaction).

## 11. S5.7 — staff cancel + move-up list (interview-approved Alec 2026-07-09, built)

- **Cancel** (the recorded hidden dependency — no cancellation affordance existed
  anywhere): a **destructive detail-card action**, deliberately outside the status
  menu (cancel removes the row and frees the window; it is not a workflow step).
  **Scheduled-only** (same reasoning as S5.5 drag: arrived/roomed are in the
  building; no-show stays the status-menu path). Undo-over-confirm: the block
  disappears immediately, a ~10s toast offers Undo; restore re-protects the window
  first and **409s honestly if the freed time was taken** inside the undo period.
  **Coded reason required** (decided over no-reason and over free text): patient ·
  practice · no-longer-needed → FHIR `Appointment.cancelationReason` under our
  CodeSystem. The freed window is immediately re-bookable — deleting the protector
  Slot is what makes `$find` offer it again. Mechanics + split principals in
  DATA_MODEL.md; endpoints in API.md.
- **Move-up list** (the 4D gap feature, COMPETITIVE_NOTES §6): a toolbar **Move-up
  panel**, oldest-first (fairness), each row showing live-resolved name · phone ·
  service · held-appointment time · practitioner preference · availability note.
  The desk calls (no SMS/push in v0), moves the appointment earlier with the normal
  reschedule tools, then marks the entry **Fulfilled** (or **Remove**). **Staff-only
  entry in v0** from the detail card ("Add to move-up list": practitioner pinned to
  the current provider with an any-provider toggle; note ≤120 chars, non-PHI by
  rule, stated at the form) — the portal "notify me if earlier opens" toggle joins
  the Phase-2 notify/growth work, where it can actually notify. Adds are undoable
  (the toast resolves the fresh entry as removed).
- **Post-cancel match cue** (the execution win over 4D's dumb list): the cancel
  toast reads "Cancelled — S. L. · 2 move-up matches" with a **View list** button
  when waiting same-service entries fit the freed column. A cue, not a promise —
  the panel is where staff judge actual fit.
- **Privacy mask** covers the panel and toasts like every patient surface (initials,
  hidden phone).
- **Auto-match on cancellation is a seam only** (Phase-2 growth engine): a Bot on
  `Appointment?status=cancelled` working `waiting` rows — the experience-DB status
  columns and the ordinary-FHIR-write cancel path are the seam (DATA_MODEL.md).

## Review log

- 2026-07-09 — **S5.7 shipped** (§11): staff cancel end to end (coded-reason detail-card
  action, undo-over-confirm with honest restore-409, protector-slot freeing) + the
  move-up list (approved `move_up_requests` experience-DB migration — ids only, live
  FHIR resolution as the caller; toolbar panel; detail-card add with any-provider
  toggle + non-PHI note; post-cancel match cue with View list). Four design decisions
  interview-approved by Alec the same day: cancel = detail-card destructive action
  WITH a coded reason; the migration as proposed; panel + post-cancel match cue with
  manual fulfil-marking; staff-only list entry in v0.

- 2026-07-06 — **Overlap layout shipped** (pulled forward from the 4D study the same day
  Alec approved the pull-forward): `columnLayout` clusters transitively-overlapping
  appointments and assigns side-by-side lanes; neither block hides the other (the old
  absolute positioning overlaid them). Lib + component regression tests; stub seeds a
  deliberate mid-procedure consult overlap so screenshot review keeps exercising it.
- 2026-07-06 — **S5c amended** (Alec, at first hands-on review): the `day-off` category
  removed — time off is a titled block ("PTO"), all-day OR timed (half-days), via an
  **All day** toggle available to every event type. Landed before any stack carried a
  `day-off` code, so the CodeSystem simply shrank to `meeting | block`. Same review:
  the greyed-out Add dead-end fixed — the form now explains every disabled state
  (unseeded stack = no practitioner schedules was the trigger).
- 2026-07-06 — **S5c shipped** (§8): internal events end to end — FHIR representation
  (patient-less Appointment + busy-unavailable Slots, DATA_MODEL.md), BFF
  `POST/DELETE /staff/events` under the service client + `events[]` on the day sheet,
  and the staff UI (New form popover + `N`, muted event blocks, detail card with
  delete/undo). Four design decisions interview-approved by Alec the same day
  (representation, write principal, scope, branch).
- 2026-07-06 — **S5b shipped** (§7): privacy glance mask (initials + hidden contact
  details, eye toggle + `P`, 2-minute idle auto-engage, one-keypress unmask) and the
  live-updating calendar (15s visible-tab polling with in-flight pause and scroll
  preservation). Four design decisions interview-approved by Alec the same day: client
  polling over SSE for v0, keypress unmask over session re-auth, 2-minute idle window,
  mask covers initials + contact details.
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
