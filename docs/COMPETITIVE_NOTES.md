# Competitive notes — what leading EMR + aesthetics software has that we should weigh

Commissioned by Alec 2026-07-02 ("consider what else we'll need to pull from leading EMR and
aesthetics software that we may be missing"). Method: parallel web-research agents over Epic
(Cadence/Snapboard), ModMed EMA (derm/plastics), Tebra, DrChrono, healthcare kiosk/privacy
practice, plus an aesthetics-vendor sweep (Boulevard, Mangomint, Zenoti, Jane, Aesthetic Record,
PatientNow, Symplast, RepeatMD). **Provenance note:** all sections are now backed by cited
research (an initial fan-out lost branches to API rate limiting; a flat retry completed the
aesthetics sweep). Vendor pages are largely bot-blocked, so citations rest on search-indexed
excerpts of the named pages. This doc is an inventory + gap analysis, not
a commitment; anything that changes v0 scope is Alec's call (proposal §5).

## 1. Scheduling — what the leaders do (cited)

- **Multi-provider day calendar with provider columns is the universal pattern**: Epic's
  Snapboard (drag-and-drop between provider columns, double-click-to-book), ModMed
  multi-provider calendars, DrChrono provider/office/exam-room columns, Tebra resource columns.
  Alec's S5 spec matches the industry-standard shape.
- **Status workflow is richer than booked/arrived everywhere**: Tebra's buckets are the cleanest
  articulation — _Scheduled_ → _In office_ (Arrived, Checked in, Roomed) → _Finished_ (Checked
  out, No show, Rescheduled, Cancelled); Epic's DAR adds end-of-day No show / Left-without-seen;
  ModMed auto-flips unconfirmed→confirmed from patient SMS replies (gray→green). DrChrono
  supports custom statuses.
- **Drag-to-reschedule is table stakes** (Epic Snapboard, ModMed Appointment Finder, Tebra,
  DrChrono — all confirmed).
- **Visit types carry duration + color** (DrChrono "appointment profiles" define duration,
  reason, forms, color; Epic/Tebra color-coded blocks and reasons). Our
  `HealthcareService`+`SchedulingParameters` model already carries durations — we should add a
  per-service **calendar color** (a categorical token ramp, not hardcoded hues).
- **Schedule templates/blocks** (provider weekly templates; restrictive vs advisory blocks like
  "new patients only 8–9am") are universal admin features — post-v0, but the data model
  (Schedule + slot generation) shouldn't preclude them.
- **A real-time complaint worth exploiting**: G2 reviewers ding ModMed because "the schedule
  doesn't update in real time" (manual refresh with multiple front-desk users). Our
  Subscriptions-driven core can make **live-updating calendars** a felt differentiator.

## 2. Privacy at the desk (cited)

- Regulatory anchor: 45 CFR 164.312(a)(2)(iii) — auto-logoff after inactivity is an
  _addressable_ HIPAA safeguard; 164.310(c) requires physical workstation safeguards. AAFP/AHIMA
  guidance recommends short screen timeouts and positioning; compliance guidance recommends
  privacy filters at reception "so patients in line can't read the receptionist's screen."
- **No vendor was confirmed to offer an in-app one-tap PHI-masking mode.** The industry solves
  this with physical filters, monitor angling, and OS screen locks. Alec's **privacy glance
  mode** (mask names→initials instantly) appears to be genuinely novel as a first-class software
  affordance — and pairs naturally with an **auto-engage on idle** (n minutes → mask engages,
  one click + session re-auth to unmask), which maps directly onto the addressable auto-logoff
  safeguard. **Correction (2026-07-06, from Alec's 4D screenshot — §6):** 4D EMR, Handal's own
  incumbent, DOES have a calendar privacy mode (blocks render "Privacy Mode Is On" in place of
  patient names). So the feature isn't novel — it's an incumbent expectation Handal's staff
  already rely on; our differentiator is the execution (initials keep the desk workable, idle
  auto-engage, one-keypress unmask) rather than the existence.
- Kiosk check-in patterns (Phreesia/Clearwave/Epic Welcome): idle timeouts that clear sessions,
  narrow-viewing-angle screens, minimal-data prompts (Epic Welcome asks only last-2-digits of
  birth year). Relevant when we do lobby check-in (Phase 2 QR flow).

## 3. Aesthetics-platform table stakes (cited — flat vendor sweep completed)

Across Boulevard/Mangomint/Zenoti/Jane/Aesthetic Record/PatientNow/Symplast/RepeatMD, the
recurring set (per-vendor citations in the research transcript):

- **Charting**: on-image injection markup is the common pattern (Mangomint's Image Markup
  annotates product, unit count, **lot/batch and expiration** per site; Aesthetic Record draws
  injection points/dosages on photos with **auto inventory deduction**; Zenoti tracks
  injectables + controlled substances). Notably, Boulevard users _complain_ about wanting more
  detailed face-chart tools — our dedicated face-map is aimed exactly at the gap. Jane is
  flagged by third parties as weak on injectable-specific charting — the generalist trap we
  avoid. Consent capture on-device before treatment and treatment templates are universal.
- **Before/after photos are universal (cited — all 14 vendors surveyed).** Capture in-workflow,
  side-by-side/overlay/slider comparison, chart-tied storage: Boulevard (Advanced Charting,
  markup + **supervisor sign-off** in its Medspa add-on — oversight built into charting), Zenoti
  (dedicated Photo Manager: consent workflows, auto-blur of identifying features, usage
  tracking, consent-withdrawal removal), Jane (side-by-side chart part), Aesthetic Record,
  PatientNow (ghosting/morphing/slider + publish-consent), Nextech/TouchMD (photo releases as a
  named consent type, gridlines for consistent angles), Mangomint, Symplast, Vagaro, Pabau,
  ModMed, ClinicSoftware. **Key pattern for our model: clinical-documentation consent and
  marketing/publication consent are separate, explicit consents** — which our Consent-per-type
  design already anticipates.
- **Product/lot/unit tracking** for injectables, often with inventory deduction at checkout
  (ModMed Package Management cited: series link to appointments, remaining-count deduction,
  expirations). Our per-product-per-lot `Medication` + CarePlan-series model already covers the
  clinical half; retail inventory/deduction is the uncovered half.
- **Money**: card-on-file, deposits at booking, no-show/late-cancel fees, tips, gift cards,
  packages/memberships (all Stripe-dependent for us — deferred with it).
- **Growth**: two-way SMS, automated rebooking/recall campaigns, review requests, referral
  programs, waitlists that backfill cancellations.
- **Patient-facing**: booking + forms/intake ahead of visit, aftercare delivery, payment on
  file, photo access.
- **GFE / medical-director oversight** (aesthetics-specific compliance, now cited): Aesthetic
  Record ships dedicated "MD & Provider Rooms" with a chart-audit workflow tracking every chart
  from creation to Medical Director sign-off (timestamped, built for state chart-review rules);
  PatientNow aligns e-prescribing to GFE clearance; Boulevard bundles supervisor sign-off into
  charting. Nothing in our model yet — needs a data-model + workflow decision before real
  operations (not demo-blocking).
- **Waitlists are smarter than expected**: Mangomint's "Intelligent Waitlist" auto-matches
  cancellations to waitlisted clients; Boulevard requires a card to join (anti-spam). Good
  Phase-2 growth-engine material (event-driven fits our Bots architecture).
- Confirmed by the sweep: **no vendor documents any screen-privacy/PHI-masking feature** —
  privacy glance mode stays a genuine differentiator.

## 3.5 Patient-facing booking conversion (added 2026-07-03 — second research pass)

Commissioned by Alec at S4 review with three binding tenets for patient surfaces:
**frictionless · premium + responsive · conversion above all**. Method: three parallel
research agents (named references Othership + Lore Bathing Club; premium-aesthetics field
Ever/Body/Peachy/Glowbar/Heyday + platforms Boulevard/Mangomint/Zenoti; published conversion
evidence — Baymard, NN/g, CXL, RCTs). Full synthesis + approved spec: `docs/BOOKING_DESIGN.md`.
Headlines for this inventory:

- **The modal premium booking shape is universal**: service-first → time-first (provider is a
  secondary "switch"; "first available" default) → identity last → confirm; 4–5 screens,
  prices visible from the first tap. Nobody premium is date-first or provider-first; nobody
  premium gates availability behind login.
- **Boulevard's conversion moat is slot presentation** ("Precision Scheduling": ML-ranked
  slots that pack provider calendars) — slot ranking is a two-sided revenue surface and a
  named post-v0 BFF/growth-engine opportunity for us. Their published data: online-first
  bookers ~2× likelier to return; 67% of Gen Z has abandoned a business over clunky booking.
- **Mangomint's differentiator is login-free booking** (SMS-code recognition, card-on-file
  pre-fill) — the strongest new-patient friction lever; informs our post-v0 signup design
  (AUTH.md review log notes it). Their injectables dataset: only ~22% of medspa bookings
  happen online today; ~22% cancel (why card-on-file matters).
- **Peachy's premium signature is flat pricing** (never per-unit at booking; clinical
  complexity moved to the visit) — adopted in our spec.
- **The named references (Othership, Lore) both run white-label booking shells** that break
  brand at the money moment; their premium is naming, photography, copy, and
  hospitality-coded policy. A brand-continuous custom flow is our structural advantage —
  same lesson as the ModMed real-time complaint above: the incumbents' seams are our
  differentiators.

## 3.6 Patient-surface distribution (added 2026-07-04 — third research pass)

Commissioned by Alec: standalone portal vs embeddable components for practice-owned sites vs
website tools. Method: two parallel research agents (distribution landscape across 15 vendors;
embed tech + HIPAA/browser constraints). Full synthesis + recommendation:
`docs/PATIENT_SURFACE.md`. Headlines:

- **Booking-step embeds are commoditized** (Boulevard's overlay is the premium bar; Mangomint
  matches; Vagaro alone ships a WP plugin) — but **nobody in medspa embeds the rest of the
  relationship** (membership/wallet/loyalty/orders/messaging all fall into off-brand hosted
  portals or app silos). Mariana Tek proves the components+API architecture — in fitness.
- **RepeatMD ($50M Series A, app-first membership/rewards layer)** proves demand for the
  experience layer and, via its complaint profile (cost, contracts, app-download wall), the
  dissatisfaction our web-first, booking-integrated version would attack.
- **Authenticated sessions don't survive third-party embeds cross-browser** (Safari ITP;
  CHIPS too young); the compliant industry line is guest flows embedded, authenticated depth
  first-party. Premium ≠ never-leave-the-page; premium = **never see the vendor**.
- **Website builders are a downmarket/acquired-agency game** — premium practices pay agencies
  for WordPress/Webflow; be what agencies love to embed instead.

## 4. Gap analysis → recommendations

| Gap                                                            | Status in our plan                        | Recommendation                                                                                                                                                |
| -------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Richer appointment statuses (arrived/roomed/completed/no-show) | S5 has booked→arrived only                | **Add to S5**: adopt the FHIR Appointment status set + status chips on the calendar (cheap; the check-in Bot already flips statuses).                         |
| Drag-to-reschedule on the calendar                             | Not planned                               | **Add as S5.5 or fold into S5 if time allows** — pairs perfectly with undo-over-confirm. Alec's call (scope add).                                             |
| Per-service calendar colors                                    | Not planned                               | **Add to S3/S5 cheaply**: categorical color tokens per service type (token-set expansion — within existing authority).                                        |
| Privacy mode auto-engage on idle                               | S5 has manual toggle                      | **Add to S5**: idle timer engages the mask (addressable-safeguard alignment); manual toggle remains.                                                          |
| Live-updating calendar (no manual refresh)                     | Implicit                                  | Make explicit in S5's verify step — it's a felt differentiator vs. ModMed et al.                                                                              |
| Before/after photos + photo consent                            | Modeled (Media/Consent), not in v0        | Keep post-v0; **first candidate after the spine** — it's the top aesthetics table-stake we lack.                                                              |
| Intake forms (Questionnaire)                                   | Modeled, not in v0                        | Post-v0, unchanged.                                                                                                                                           |
| Waitlist, deposits, no-show fees, tips, gift cards             | Not planned (Stripe deferred)             | Phase 2 with Stripe — record as explicit Phase-2 backlog.                                                                                                     |
| Two-way SMS, recalls, reviews, referrals                       | Growth engine (Phase 2)                   | Unchanged; SMS vendor needs BAA + approval gate.                                                                                                              |
| Retail inventory / unit deduction at checkout                  | Clinical lot tracking modeled; retail not | Phase 2/3 with commerce.                                                                                                                                      |
| **GFE / medical-director oversight**                           | **Absent from data model + roadmap**      | **New roadmap item (pre-real-operations)**: model GFE as an async review/sign-off workflow; regulatory-adjacent → Alec + data-model amendment when scheduled. |
| Schedule templates/blocks admin                                | Not planned                               | Phase 2+; keep slot generation compatible.                                                                                                                    |
| Tasks/inbox, documents, fax, eligibility, labs                 | Not planned                               | Mostly N/A for cash-pay medspa v0; revisit at Handal migration (Phase 3).                                                                                     |

## 5. Proposed v0 spec deltas (for Alec's approval — scope adds)

1. **S5**: FHIR-status workflow + status chips; privacy-mask auto-engage on idle; live-update
   verify step. (Small adds.)
2. **S5 stretch / S5.5**: drag-to-reschedule with 10s undo. (Medium add.)
3. **S3**: per-service categorical color tokens. (Small add, within token authority.)
4. **Roadmap**: add GFE/medical-director oversight as a named pre-production item; add
   before/after photos as the first post-spine slice candidate.

## 6. 4D EMR (Handal's incumbent) — schedule study (Alec's screenshot, 2026-07-06)

Alec's read: "this schedule functionally is good, even if the actual UX and flows suck."
Inventory of what its day view carries, mapped against our plan. The functional bar it sets
is real — 4D is what Handal's staff use every day, so anything they lean on that we lack is
a migration blocker, not a nice-to-have.

**Already ours (and better executed):** per-practitioner day columns · day/work-week/week/
month views · date picker + Today · status/flag signals on blocks · calendar privacy mode
(see the §2 correction — theirs replaces block text with "Privacy Mode Is On"; ours keeps
the desk workable with initials, idle auto-engage, one-keypress unmask) · full-day column
designations like "SURGICAL DAY" (ours: an all-day titled block since the S5c amendment) ·
live updates (they have a manual **Refresh** button; we poll — a felt win, keep it).

**Genuine gaps, worth planned homes:**

| 4D feature                                                                     | What it is                                                                      | Where it should land with us                                                                                                                                                                               |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Resource columns ("OR 2") + Room Manager view**                              | Rooms/ORs are schedulable calendars alongside providers                         | Post-v0 (pre-Handal-migration it's REQUIRED — surgical practices schedule rooms). FHIR fits: a Schedule's single actor can be a Location. Keep the data model non-precluding (existing §1 note stands).    |
| **All-day lane**                                                               | A dedicated strip above the grid for all-day items                              | UX refinement of S5c's all-day wash — candidate for the Month/Today design round rather than a wash spanning 24h of grid.                                                                                  |
| **Side-by-side overlap layout**                                                | Overlapping appointments in one column render in sub-columns, all readable      | **Real defect risk for us today** — our absolute blocks overlay on overlap. Needed before real data (double-booked columns happen: consults during procedures). Queue with S5.5 drag work.                 |
| **Calendar visibility toggles + groups**                                       | Left-rail eye toggles hide/show providers; named groups                         | Needed when practitioner count grows (Handal has 6+ columns). Cheap once URL-state practitioner filtering generalizes; post-v0.                                                                            |
| **Find Openings**                                                              | Next-available search from the desk                                             | Planned as S11 assistant capability ("find an opening…"); consider a plain toolbar affordance too when S11 lands — not everyone will ask the assistant.                                                    |
| **Move-up list**                                                               | Waitlist of patients wanting earlier slots; desk works it when time opens       | **Not in our plan anywhere** — the §4 waitlist row was deposits-flavored. This is a scheduling-revenue feature (fills cancellations). Name it as a Phase-2 backlog item with the growth engine.            |
| **Jump ahead (1/2/3/4/6/8 wks, 3/6 mo)**                                       | One-tap relative navigation matching rebooking cadences ("see you in 3 months") | Small, high-leverage for rebooking flows. Candidate for the rebooking/concierge slice (S10) or a toolbar nicety with Month view.                                                                           |
| **Appointment-type filter + appointment search**                               | Filter the grid by type; find a patient's appointment                           | Search belongs to S11 (⌘K); a type filter is a Month/density-pass candidate.                                                                                                                               |
| **Zoom (grid density)**                                                        | Slider scales the hour height                                                   | Nice-to-have; our HOUR_PX is a constant — trivially tokenizable if tablets want denser views. Backlog.                                                                                                     |
| **Block metadata glyphs (H/U/$/✓) + change annotations ("Changed quote on…")** | Hold/unconfirmed/payment/confirmed markers and inline audit notes on blocks     | Confirmation states arrive with reminders/SMS (growth engine); payment flags with commerce; change history exists in FHIR meta — surfacing it is a detail-card candidate, not block chrome (their UX sin). |

**What we deliberately won't copy:** the color chaos (every block shouts), modal-dense
chrome, manual refresh, and burying patient names under a privacy string that makes blocks
unreadable — the quiet-tool tenets (DESIGN.md) are the answer to exactly this screen.
