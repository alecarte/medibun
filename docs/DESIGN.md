# Design tenets — binding

Calibrated with Alec 2026-07-02 (v0 proposal §6 rev. 2 is the visual system; this doc is how we
use it). These tenets exist to keep Medibun distinctive and crafted — the explicit brief is to
avoid the generic "AI slop / vibe-code" register and sit alongside the best product software.

## Calibration

- **Two registers (amended 2026-07-03, Alec).** The **staff app stays a quiet tool** (restrained,
  keyboard-first, content-first). The **patient portal is a premium consumer product**, governed
  by three tenets — **frictionless · premium + responsive feel · conversion above all** — with
  every design choice research-backed (see `docs/BOOKING_DESIGN.md` for the evidence base and
  the banned dark-pattern list: no countdowns, presence counters, panic badges, hidden prices,
  or login walls before availability). Personality still comes from signature objects, motion,
  and content — never decoration for its own sake.
- **The bar:** Anthropic/Claude (ivory warmth, generous whitespace, editorial type confidence,
  quiet chrome) × Notion (soft approachability, content-first, friendly without being cute).
  Explicitly _not_ cold-dense; warm-neutral and calm.
- **Never:** gradient heroes, emoji in UI, stock illustrations, marketing verbs, purple-default,
  factory-styled components shipped unmodified, decoration that could belong to any product.

## Tenets

1. **The domain is the design.** Craft budget concentrates on the objects only we have: the
   **face-map** (a custom, precisely-drawn line-art schematic — a beautiful technical drawing,
   injection points rendered in the brand accent; decided 2026-07-02), the **treatment card**
   (dose anatomy set in data type: `50 u · glabella · lot C3421A`, tabular-nums always), the
   **day sheet**, the **timeline**. Chrome stays quiet so these carry the identity.
2. **Few decisions, ruthlessly consistent.** Accent color appears only as action / active /
   focus. One easing family, one radius language, sentence case everywhere. Numbers are always
   tabular. Restraint reads as confidence; variety reads as generated.
3. **A written voice.** Calm, concrete, zero exclamation marks. Confirmations state the outcome
   ("Booked for Thursday 2:30"), never celebrate ("Success!"). Errors say what happened and what
   to do next, and never blame the user. Every string in a PR is held to this.
4. **Intuitive = subtraction + speed.** Patient screens have one primary action. Staff surfaces
   are keyboard-first and never pull the user off the schedule to complete a task.
   **Undo-over-confirm (decided 2026-07-02):** reversible staff actions (check-in, reschedule)
   execute immediately with a ~10s undo; clinical writes (S7/S8 capture) always keep explicit
   human confirmation. Optimistic UI everywhere — perceived speed is most of "intuitive."
5. **Real content, always looked at.** Every surface is designed against realistic synthetic
   data (long names, 12-site treatments, edge cases). Empty, loading, and error states are
   designed, not defaulted. No slice ships without its screens being screenshot-reviewed.
6. **Patient surfaces convert — honestly (added 2026-07-03; evidence in BOOKING_DESIGN.md).**
   Price and duration are always visible before commitment (late-revealed costs are the #1
   abandonment cause); choices are curated, never dumped (4–7 options per screen, 5–8 time
   chips per day — a wall of options is friction wearing a completeness costume); smart
   defaults do the remembering ("Book your usual", first-available provider, last choices
   pre-filled — never a preselected upsell); identity and commitment come last, after the
   thing is emotionally theirs; the confirmation screen is the start of the next visit
   (add-to-calendar, prep content, arrival ritual), not a receipt. Scarcity only when
   truthful and service-framed ("Saturdays usually fill by Wednesday"); countdowns, presence
   counters, panic badges, and fake anchoring are banned — detected manipulation is fatal to
   premium. Perceived response stays under ~400ms (prefetch, optimistic UI; skeletons only
   for sub-second, layout-stable loads).

## Mechanics that enforce this

- Tokens are the only source of visual values (CLAUDE.md); CI contrast tests gate WCAG 2.1 AA.
- Each slice's verify step includes a visual review against these tenets.
- Copy review is part of code review: strings are diff-reviewed like code.
- A "signature moment" budget of at most one or two per surface (see proposal §6 motion) — used
  where the journey earns it (booking confirmed, capture committed), nowhere else.
