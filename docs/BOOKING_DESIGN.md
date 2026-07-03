# Booking design direction — research synthesis + spec

**Status: APPROVED (Alec, 2026-07-03) — the §3 spec is the booking baseline, explicitly built
for continued refinement: everything visual rides the token layer + swappable assets, and the
§5 evidence gaps are ours to A/B once instrumentation lands. The lessons here inform all
patient-surface design (see DESIGN.md calibration).**

Commissioned by Alec 2026-07-03 at S4 review, with three binding tenets for all patient-surface
design: **frictionless · premium + responsive feel · conversion above all** — every choice
research-backed, not vibes. Inputs: three parallel research passes (named references
Othership + Lore Bathing Club; the premium-aesthetics competitive field incl. Boulevard/
Mangomint/Zenoti and Ever/Body/Peachy/Glowbar/Heyday; published conversion evidence —
Baymard, NN/g, CXL, RCTs and meta-analyses). Full cited reports live in the session record;
key citations inline below.

---

## 1. What the research converges on

### The modal premium flow shape (every leader does this)

**Service-first → time-first (provider is a secondary "switch") → identify last → confirm.**

- Nobody premium is **date-first** (that's OpenTable's problem shape: party/time before venue).
  Availability depends on service duration + provider, so calendar-first produces false
  availability and dead-end days. Every clinical scheduler (Zocdoc included) collects
  visit-type before showing times.
- Nobody premium is **provider-first** (the hair-salon pattern). The winning provider UX:
  **"first available" as the default**, named providers one tap away (Boulevard's "switch
  provider at this chosen time" affordance; Ever/Body's "next available"; Glowbar's
  "same experience no matter who you see").
- Identity comes **after** the slot is emotionally "theirs": Baymard — forced account creation
  is the #2 abandonment cause; Boulevard sequences password creation after value; Mangomint is
  fully login-free (SMS-code recognition). Zocdoc's availability-before-forms redesign
  converted ~75% higher (self-reported).

### The conversion evidence that binds design choices

| Rule                                                                                                                                      | Evidence                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| ≤3–4 chunked steps, ≤8 total fields; friction-per-step beats step count                                                                   | Baymard checkout corpus; Expedia's $12M deleted field                                                                                |
| Short fast-looking step indicator; never a crawling progress bar                                                                          | Villar et al. meta-analysis (slow progress feedback hurts); endowed-progress RCT (start it partly filled)                            |
| Show prices up front ("$395 · 30 min" on the card, exact total before confirm)                                                            | Baymard #1 abandonment = late costs; medspa consensus: hidden prices send patients to competitors                                    |
| Curate choices: 4–7 services/screen, 5–8 time chips/day grouped morning/afternoon/evening — never every 15-min increment                  | Chernev et al. choice-overload moderators; INFORMS slot-offer sequencing (curated sets fill calendars better than "show everything") |
| Interactions <400ms perceived; optimistic UI; skeletons only for sub-second layout-stable loads                                           | Doherty threshold; Google/Deloitte: +8–10% conversion per 0.1s (luxury segment); Viget skeleton caveat                               |
| Scarcity only truthful + service-framed ("Saturdays usually fill by Wednesday"); ban countdowns, presence counters, per-slot panic badges | Teubner & Graul (scarcity works) vs dark-pattern trust research + Airbnb's own rejected tests                                        |
| Card-on-file **hold** framed as reassurance ("reschedule free up to 24h") — post-v0, with Stripe                                          | OpenTable −16% no-shows; Expedia flexibility framing +up-to-35%                                                                      |
| Confirmation = start of show-up engineering: add-to-calendar, prep content, reminder cadence                                              | SMS-reminder RCTs (−38% no-shows); prep content is a no-show intervention disguised as concierge care                                |

### Vertical-specific facts worth building around

- Only ~22% of medspa appointments are booked online today (Mangomint, ~20k-appointment
  dataset) vs 43% for massage — the online channel is underbuilt, not undemanded. ~22% of
  medspa bookings cancel — why card-on-file matters post-v0.
- 67% of Gen Z / 64% of Millennials have abandoned a business entirely over clunky booking
  (Boulevard survey, n>2,000). Online-first bookers are ~2× likelier to return.
- **Flat pricing is the premium signature in injectables** (Peachy): per-unit pricing is the
  #1 booking anxiety; the leaders never expose units/dosing in the flow — clinical complexity
  moves to the visit.
- **New-injectable-patient entry is a free consultation** everywhere (Ever/Body, Peachy,
  Alchemy 43) — that's the Good Faith Exam requirement dressed as hospitality. (Post-v0:
  signup + GFE flow; already noted in ROADMAP.)
- **Both named references (Othership, Lore) run white-label booking shells** (Mariana Tek,
  Zappy) that visibly break brand at the money moment, and Lore walls booking behind an app
  install. Their premium feel is carried by naming, photography, copy, pricing architecture,
  and hospitality-coded policy. A custom, brand-continuous, web-bookable flow is exactly
  where Medibun can beat the references.
- Patterns to steal from them: outcome-named tiny service taxonomy (Othership's
  "Up / Down / All Around"), waitlist-with-commitment, hospitality-coded policy copy
  ("send a love note to the front desk"), **confirmation as pre-arrival ritual** (arrival
  choreography, prep expectations), credit/membership one-tap rebooking economics (post-v0,
  pairs with Stripe + PHI-free credits).

## 2. Verdict on the flow-shape question

Alec's lean was date-first calendar; the evidence says **service-first, then time-first
within the service** — date-first is the one shape no premium player in this vertical uses,
because it shows false availability and forces the patient to search instead of choose. The
frictionless-feel goal date-first was reaching for is delivered instead by: a horizontal
**day strip** (next 7 days, fullness visible per day) + curated time chips below it, provider
demoted to a "switch" affordance, and everything pre-fetched so day-switching feels instant.
The current S4 structure (service cards → practitioner + day-grouped chips) is already
structurally the modal shape; the gaps are presentation register, provider demotion, slot
curation, sticky CTA, and the confirmation ritual.

## 3. Proposed spec (v0 scope — logged-in patient, synthetic data, no payments)

**Screen 1 — Service menu `/book`.** Premium consumer register: larger editorial service
cards (category-tinted washes now; real photography is a token/asset swap when branding
lands), flat price + duration on every card ("$395 · 30 min"), 3–7 services grouped if the
menu grows, one-line outcome-oriented descriptions. Returning patient sees "Book your usual —
Botox with Riley" as a pre-filled fast path (defaults evidence).

**Screen 2 — Time picker `/book/[code]`.** Step indicator ("Step 2 of 3", starts partly
endowed). Day strip across the top (7 days, per-day fullness signal, truthful only);
**time chips grouped Morning / Afternoon / Evening, 5–8 per day** ranked by the BFF
(nearest-first for v0; Boulevard-style calendar-packing rank is a flagged post-v0 BFF
feature); **"First available" is the default**, with a provider row (photo placeholder +
name) exposing a "switch practitioner at this time" affordance and bios one tap away.
Selection raises a **sticky bottom bar** (thumb-zone evidence): summary + "Book 2:30 PM".
Availability pre-fetched per day; skeleton chips only under 1s.

**Screen 3 — Confirmation.** Optimistic (kept from S4), then the pre-arrival ritual:
"Booked for Thursday, July 9 at 2:30 PM" · add-to-calendar (.ics — no vendor needed) ·
practice-authored prep content ("skip alcohol 24 hours before") · arrival note · calm
reschedule/cancel affordance worded as freedom ("Reschedule free up to 24 hours before").
This screen is the cheapest premium win in the whole flow and doubles as no-show
engineering.

**Register (all three screens):** premium consumer product — richer cards, original-
photography-ready layouts, confident type scale, one signature motion moment (booking
confirmed), interactions <400ms perceived. Voice guide unchanged (calm, concrete, zero
exclamation marks). Accent stays action/active/focus-only.

**Shell (rev. 3 direction, Alec 2026-07-03):** the sidebar profile block gains a **generated
avatar** (deterministic gradient/initials from name/id — shadcn/Claude register; never a
photo, so nothing PHI-shaped enters the shell), with designed-but-dormant slots for **wallet
balance** (credits) and **membership/loyalty status** that activate when the commerce phase
delivers real data. **AI seams get placement now, features later:** the concierge ("Ask") as
sidebar entry + a contextual "Not sure? Ask us" affordance beside the service menu (populated
in S10), and a recommendation rail slot on the menu/home ("for you" — new services, "time for
your next visit") populated by the Phase-2 growth engine. AI surfaces inherit the grounded/
cited/human-confirmed rules and ADR-0004 gates.

**Explicitly banned (trust/premium):** countdown timers, presence counters, per-slot panic
badges, fake anchoring, hidden prices, login walls before availability, app-install walls,
off-brand booking surfaces.

## 4. Parked with owners (not built now)

| Item                                                  | Why parked                                                                         | Lands with                    |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------- |
| Guest booking + SMS-code identity (Mangomint pattern) | Signup + phone OTP deferred (A1); biggest single conversion lever for new patients | Post-v0 signup slice          |
| Card-on-file hold + reassurance-worded policy         | Stripe deferred; no payments in v0                                                 | Commerce phase                |
| SMS reminder cadence (RCT-backed −38% no-shows)       | Comms vendor + BAA                                                                 | Growth engine                 |
| Free-consultation / GFE new-patient flow              | Regulatory (GFE); no new patients in v0                                            | Post-v0 (ROADMAP note exists) |
| Boulevard-style calendar-packing slot ranking         | Real BFF IP; needs demand data                                                     | Growth engine (Bots/BFF)      |
| Funnel instrumentation / A/B culture                  | PostHog deferred (BAA, no-PHI config)                                              | Observability slice           |

## 5. Evidence gaps we own

No strong published A/B exists for: service-first vs date-first ordering, day-strip vs month
grid, exact chip counts, imagery style. These are practitioner-consensus choices — instrument
and test them ourselves once PostHog lands (Booking.com's core lesson: local testing beats
borrowed patterns).

## Review log

- 2026-07-03 — Proposed, from the three-tenet directive (Alec) + three research passes.
  DESIGN.md amendment recorded alongside (patient-portal register moves from
  "quiet editorial" to "premium consumer"; staff app stays quiet-tool).
- 2026-07-03 — **Approved (Alec)** against register mockups (menu + time picker): "a lot
  closer to the vision and the eventual product," with the explicit expectation of room to
  refine over time. Lessons propagated to DESIGN.md (patient-surface tenets),
  COMPETITIVE_NOTES.md (booking-conversion research), ROADMAP.md (post-v0 conversion
  levers), AUTH.md review log (guest/SMS-first identity note), and V0_PROPOSAL §6/§9.
