# v1 Proposal — the Revenue Re-Cut

**Status: APPROVED (Alec, 2026-08-11 — B-series decision states recorded in §12) — in
execution. This document supersedes the _unbuilt remainder_ of `V0_PROPOSAL.md` (S6–S12
survive, resequenced in §5; the S5 family is frozen per §4). The V0 supersession header,
per-doc review-log entries, and §8 PROJECT_BRIEF amendments landed with the approval
bookkeeping (same change as this status).**

Author: Fable session, 2026-08-11. Inputs: the full repo (docs, slice log, all apps/packages),
the Recovered Revenue memo (2026-08-11, external), the strategy synthesis conversation of
2026-08-11, and the V0 slice-log state (S1–S5.7 built, S6–S12 unstarted).

This document is the living record of v1: as slices land, §9 tracks status so any fresh session
can resume from the repo alone.

---

## 1. The one thing v1 must prove

**The platform can put a dollar figure on itself.** V0's thesis (medical software doesn't have
to feel like medical software) is unchanged and still gets proven — but _after_ the platform
proves it can recover measurable revenue at a real practice:

> Handal's two-plus years of 4D data (R0 pulls ≥ 24 months, per RECOVERY_DESIGN §2) are
> ingested and classified into three leak pools →
> a Leak Report states, in dollars, what the practice is losing → a sequenced, PHI-minimal,
> multi-touch recovery campaign works the dormant pool over 4–6 weeks, every touch terminating
> in the already-built one-tap booking flow → every contact, response, and booking lands in an
> attribution ledger against a contractual definition of "recovered" → a weekly report states
> recovered appointments and first-visit revenue, measured against a randomized holdout.

Two theses, one spine, strict order: **revenue first (R-track), differentiation second
(L-track = the surviving S6–S12)**. The R-track is also, deliberately, the productization
seed: every ingestion adapter is future migration tooling, every diagnostic is the future
sellable service, and the attribution ledger is the future SaaS's core asset.

## 2. What changed since V0, and why

- **Aureva has no timeline pressure** (construction) — so the launch spine no longer has to go
  first, and the family's only _real_ patient dataset (Handal, on 4D) becomes the priority.
- The Recovered Revenue analysis (memo, 2026-08-11) identified the outcome-priced recovery
  service as the strongest wedge; the repo already contains its conversion endpoint (S4/S4.5
  booking) and its operator surface patterns (staff app idioms). The missing pieces are
  ingestion, comms, guest identity, the sequencer, and the ledger — the R-slices.
- The V0 growth-engine deferral reasoning ("its levers are commerce, outbound messaging, and
  event volume") is inverted by this cut: outbound messaging + measurement _are_ the wedge;
  commerce is still not needed and **Stripe stays deferred**.
- **Paperwork is now revenue-critical, not launch-critical.** Real Handal PHI in any cloud
  requires the BAA chain (§7). Until then, real-data work runs **local-only on
  practice-controlled hardware** (see RECOVERY_DESIGN.md §7) — which the R0–R2 design
  explicitly supports.

## 3. Surfaces: what grows, what's frozen, what waits

| Surface               | v1 treatment                                                                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api` (BFF)      | **Grows the R-spine.** Import endpoints/CLI, segmentation, comms boundary, sequencer, ledger, guest-token booking, weekly report.                                      |
| `apps/staff`          | **One new destination: `/recovery`** (the daily recovery queue — approve/edit/skip drafted touches; RECOVERY_DESIGN.md §6). Schedule family otherwise **frozen** (§4). |
| `apps/portal`         | **Grows guest entry.** Tokenized `/book` entry with SMS-code identity (R4). Otherwise unchanged until L-track.                                                         |
| `apps/patient-mobile` | **Stays stubbed** (unchanged from V0).                                                                                                                                 |
| New: report artifact  | The Leak Report renders as a print-quality HTML/PDF (the sales asset and the diagnostic deliverable).                                                                  |

## 4. Frozen (parked, not dropped — the schedule is DONE for v1)

S5.8 room/resource columns · Month view · the Today staff dashboard · touch drag ·
keyboard reschedule · week-view drag · S5.7's Phase-2 auto-match Bot. None of these may be
picked up before R6 ships without a re-cut. Rationale: the schedule already exceeds
competitive table stakes (COMPETITIVE_NOTES §1); marginal hours belong to the revenue thesis.

## 5. Slice sequence

Discipline unchanged from V0: TDD, small diffs, security-reviewer on anything touching
PHI/auth/AccessPolicy, seed + one-command demo grow with every slice, CI green on `main`.
New standing rule for the R-track: **real PHI never enters a fixture, seed, log, or cloud
environment; real-data verification happens only via the local runbook**
(RECOVERY_DESIGN.md §7).

| #      | Slice                                       | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Verify step                                                                                                                                                                                                                                                                                   |
| ------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R0     | 4D export + assessment                      | Not a code slice. Alec pulls Handal's 4D exports (patients, appointments, inquiries/calls if available, consult outcomes if available) per the RECOVERY_DESIGN.md §2 shopping list; a Fable session assesses coverage/quality and records the findings + field mapping in RECOVERY_DESIGN.md's review log. Starts every §7 paperwork clock the same day.                                                                                                                                                                                                  | Field mapping recorded; each pool marked feasible / degraded / infeasible for Handal's data.                                                                                                                                                                                                  |
| R1     | Staging schema + 4D adapter                 | Approval-gated (B2) experience-DB migration: `imports`, `staged_patients`, `staged_appointments`, `staged_inquiries`, `staged_consults` (administrative/financial fields only — RECOVERY_DESIGN.md §3). 4D CSV parser as the first adapter behind a common `SourceAdapter` interface; import CLI with row-level rejects report; idempotent re-import by source row identity. Synthetic 4D-shaped fixtures for tests.                                                                                                                                      | Synthetic import round-trips green; real export imports cleanly via the local runbook (counts reconciled against 4D's own totals).                                                                                                                                                            |
| R2     | Segmentation + Leak Report v1               | Pool queries over staging (dormant/lapsed by service-category expected-return interval; non-booked inquiries w/o follow-up; unconverted consults), each with expected-value math from a per-service-category ticket table (financial config, experience DB). **The `service_categories` table (RECOVERY_DESIGN.md §3) lands here via its own approval-gated B2 migration PR.** Report generator → print-quality HTML/PDF: pool sizes, dollar values, methodology notes, holdout plan.                                                                     | The Handal Leak Report is produced from real data via the local runbook and Alec signs off on the numbers' face validity.                                                                                                                                                                     |
| R3     | Comms boundary + templates                  | ADR-0005 (B4): comms vendor(s) for SMS + email (BAA-capable; Twilio + Postmark are the defaults to evaluate). One choke-point module (`apps/api/src/comms` or `packages/comms`) — the only place vendor SDKs are imported; template library (PHI-minimal per the amended messaging standard, B3); STOP/unsubscribe webhook handling; quiet-hours enforcement (practice-local); send ledger rows. Synthetic-only until the vendor BAA lands.                                                                                                               | Unit: PHI gate blocks non-template sends; STOP marks the contact and blocks the sequence; no SDK import outside the module (lint rule). Live send deferred to the BAA gate.                                                                                                                   |
| R4     | Guest booking via tokenized links           | Un-defers the phone-OTP decision (AUTH.md; gate B5). Opaque, short-lived, single-patient tokens deep-link into `/book`; SMS-code verification binds the session to the known Patient; no portal account required; booking lands through the existing S4 endpoints. Token issuance only by the sequencer/BFF; enumeration-safe; rate-limited.                                                                                                                                                                                                              | Live (synthetic): token link → code → book in under a minute on a phone; expired/reused tokens fail closed; security-reviewer PASS; Alec merges (auth).                                                                                                                                       |
| R5     | Sequencer + ledger + recovery queue         | Per-(patient, pool, campaign) state machine (enrolled → in-sequence → responded / booked / recovered / opted-out / exhausted / excluded) with per-pool cadence config; **v1 sends nothing un-approved** — the `/recovery` queue in the staff app is where a human approves/edits/skips each drafted touch (automation level is per-campaign config, later). Attribution ledger tables (B2) + the Medplum `Communication` mirror for PHI-bearing content (B2); "recovered" implemented exactly per the B8 contractual definition; weekly report generator. | Synthetic end-to-end: enroll a pool → queue drafts → approve → (stub) send → guest-link booking → ledger shows a recovered appointment with full contact chain; holdout members carry the immutable holdout flag (enrolled per B8) and provably receive zero touches; security-reviewer PASS. |
| R6     | Engagement zero (Handal)                    | Real campaign against Handal's dormant pool with the B8 holdout (default 20%, randomized at enrollment). Requires: BAA chain complete for every touched cloud service (§7), Minduo↔Handal BA agreement signed, B6 write-back decision implemented, prod stack live. Weekly reports to Alec; 4–6 week cadence runs on calendar time.                                                                                                                                                                                                                       | The campaign runs; week-2 checkpoint confirms sends, opt-outs, and attribution all behave; final measurement vs holdout at campaign end against the §10 criteria.                                                                                                                             |
| S6–S12 | L-track (resequenced, unchanged in content) | The V0 AI spine — boundary module, face-map manual + ambient capture, history timeline, concierge, staff assistant, demo polish — begins once R5 is merged and R6 is running (campaign time is calendar time; build capacity frees up). All V0 gate decisions (A2–A7) carry over unchanged.                                                                                                                                                                                                                                                               | V0 §8 demo script, unchanged, remains the L-track bar.                                                                                                                                                                                                                                        |

Reordering within the R-track to unblock a dependency is the session's call; changing scope or
dropping a slice is a re-cut → Alec. R3 and R4 may be built in parallel branches after R2.

## 6. Approval-gated asks — batched as one decision set (B-series)

- **B1 — The cut itself**: R-track first, S6–S12 resequenced behind it, the §4 freeze, Stripe
  still deferred, mobile still stubbed. Recorded here + V0 supersession header on approval.
- **B2 — Data-model amendment** (DATA_MODEL.md review log; full design RECOVERY_DESIGN.md §3):
  (i) recovery **staging tables** in the experience DB, restricted by rule to
  administrative/financial fields (identity, contact, appointment times/statuses/service
  category, inquiry outcomes, ticket values) — never clinical content; (ii) **attribution
  ledger** tables (ids + territory-free metadata + amounts); (iii) outbound message content
  recorded as org-tagged Medplum **`Communication`** resources (the PHI-bearing record lives
  clinical-side; the ledger keeps ids); (iv) new CodeSystems `…/recovery-pools` and
  `…/outreach-templates`.
- **B3 — Messaging standard (constitution clarification)**: CLAUDE.md's "PHI never in SMS
  bodies" is amended to the precise standard in RECOVERY_DESIGN.md §5: outbound bodies carry
  at most first name + practice name + an opaque link; **never** clinical, treatment, visit-
  reason, or health-status content; all bodies come from the reviewed template library.
  (Rendered into CLAUDE.md on approval — a constitution edit, so it is explicitly Alec's.)
- **B4 — Comms vendor ADR-0005 + dependency approval** (new PHI-touching service(s); BAA
  clocks start at R0 regardless of final vendor pick).
- **B5 — Guest identity auth change** (tokenized entry + SMS-code verification; un-defers the
  AUTH.md phone-OTP deferral). Alec merges, as with all auth.
- **B6 — Handal write-back decision** (RECOVERY_DESIGN.md §8; needed before R6, not before
  R5): recovered bookings land in Medibun — (a, recommended) Handal front desk works
  recovered bookings from the Medibun staff schedule and mirrors to 4D until Phase H (the
  Handal migration), or (b) front-desk confirm loop with manual 4D entry per booking.
- **B7 — Paperwork (Alec-only, clocks start at R0)**: the full queue — BAAs and non-BAA
  clocks alike — is **`docs/BAA_CHECKLIST.md`** (single source; not enumerated here). One
  scoping note kept with the gate: the Anthropic BAA is no longer R-critical (template sends
  need no LLM) but still gates L-track real-PHI AI and optional LLM-drafted outreach later.
- **B8 — The contractual definition of "recovered" + holdout**: _an appointment booked by a
  contact this system initiated, from a defined pool snapshot, by a patient not in the holdout,
  within the campaign's attribution window (default 45 days from last touch), excluding
  appointments the practice booked through any other channel first._ Holdout default 20%,
  randomized at enrollment, immutable for the campaign. This definition is implemented
  verbatim in R5 and quoted verbatim in every report.

## 7. External asks — Alec's paperwork queue

The full queue — every BAA plus the non-BAA clocks (TCPA counsel, 10DLC, DoseSpot, Apple
Developer) — lives in **[`BAA_CHECKLIST.md`](BAA_CHECKLIST.md)**, the single admin file, with
per-row gates and lead times. Owner: Alec; every clock started at R0 **except 10DLC**, which
starts only at the B4 vendor pick. The complete R6 gate (uniting this section and §5's R6
row): the BAA chain for every service on the real-data and send paths, the Minduo↔Handal BA
agreement, carrier registration, the B6 write-back decision, and the prod stack. **Sentry and
PostHog are the explicit exception** — R6 may launch without observability; that is Alec's
call to make explicitly (flagged in ROADMAP), not an automatic blocker. The Anthropic BAA
gates only L-track real-PHI AI, not the R-track; DoseSpot's multi-month clock gates Phase H
(pullable forward — hence its R0 start).

## 8. PROJECT_BRIEF amendments (applied on B1 approval)

Applied to `PROJECT_BRIEF.md` §2 ("Decisions already made") on 2026-08-11 — **the brief is the
canonical home**; this section is the historical record of what was applied:

- **The productization wedge is the recovery engine, not the platform.** The sellable offer is
  a paid Leak Report diagnostic followed by an outcome-priced recovery engagement; the platform
  (front office → clinical) is sold _behind_ it, module by module, to customers the engine has
  already won. Every ingestion adapter doubles as migration tooling for the corresponding EMR.
- **Marketing/loyalty/consumer-app features are lab-track only** until R-track customers create
  pull: built as Medibun modules for Handal/Aureva behind flags, with no speculative
  multi-tenant polish, entering the sold product only as **lapse prevention** (the retention
  tail of recovery).
- **External-client data isolation**: the first _non-family_ diagnostic runs in a separate
  Medplum Project per ADR-0003's escape valve unless the standing "before the second tenant"
  hardening list is closed first — decided by a new ADR when that sale exists.

## 9. Slice status log

| Slice  | Status                                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R0     | In progress (Alec)                    | Blocks R1 verification (not R1 build — synthetic fixtures first). B7 (2026-08-11): Alec is pulling the 4D exports and starting every §7 clock in parallel — the build does not wait on him.                                                                                                                                                                                                                                                                              |
| R1     | **Merged** (PR #21, Alec, 2026-08-13) | Staging migration (B2's first — approved by the merge, per the gate's own rule), `SourceAdapter` + 4D CSV adapter, local import CLI with rejects report. Synthetic fixtures only; real-export verification waits on R0 and runs via the §7 local runbook. Follow-up (small, not R1): `scripts/seed-demo.ts` prints a raw caught `err.message` from a drizzle-backed script — synthetic-only today, but both scripts should share the import CLI's failure-printing rule. |
| R2–R6  | Not started                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| S6–S12 | Parked pending R5 merge               | All V0 decisions (A2–A7) carry over unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                           |

## 10. Engagement-zero success criteria (the go/adjust/kill bar)

Measured against the holdout in two reads (decided 2026-08-13): a **preliminary readout at
campaign end (~W12)**, where an early Go may be called if the bar is already cleared, and the
**binding Go/Adjust/Kill — and any invoice-grade recovered number — at attribution-window
close (~W17–18**, per B8's 45-day window from last touch). Deliberately asymmetric: never
Kill on data the B8 definition itself calls incomplete.

- **Go** (sell the first external diagnostic): ≥ 10 incremental recovered appointments vs
  holdout-adjusted baseline, OR incremental first-visit revenue ≥ 3× the R-track's
  fully-loaded build cost; opt-out rate < 3%; zero attribution disputes Alec can't defend
  from the ledger alone.
- **Adjust** (re-run with changed cadence/copy/pools): positive but below Go; the ledger shows
  _where_ the funnel leaks (delivery, response, booking completion).
- **Kill the outcome-pricing thesis** (platform survives; revert to L-track/launch focus):
  recovery rate statistically indistinguishable from holdout after a full cadence, or data
  access proves unworkable at diagnostic time for the beachhead systems.

## 11. Timeline (aggressive, gate-honest)

Weeks from B1 approval; build weeks assume Fable-orchestrated Claude Code at the repo's
established slice cadence; the true floor is §7 paperwork + R6 calendar time, not coding.

- **W1** — R0 (export + assessment); all §7 clocks started; B-series decided.
- **W2–3** — R1, R2. _Week-3 artifact: the Handal Leak Report, real numbers, local runbook._
- **W3–5** — R3 ∥ R4.
- **W5–6** — R5. Prod stack stands up as BAAs land.
- **W6–7** — R6 launches (hard-gated on the BAA chain + B6). Campaign runs W7–12.
- **W7+** — L-track resumes (S6 onward) while the campaign runs.
- **W12** — R6 preliminary readout against §10 (early Go allowed). **W14–16** — L-track spine
  complete; Aureva launch-ready. **~W17–18** — attribution window closes; binding §10 decision.

## 12. Review log

Terse by design (simplified 2026-08-13, Alec: "clear out the clutter") — one decision block
per bullet, newest first, multiple bullets per date allowed; the git history holds the long
form.

- 2026-08-13 — **B-series closeout (Alec, in-session)**: **B4 decided** — Twilio for SMS
  (ADR-0005 Accepted; start the Twilio BAA and the 10DLC brand + healthcare-campaign
  registration now — the clock B4 was blocking); email rides the same Twilio BAA conversation
  as SendGrid, with **Mailgun the pre-approved fallback** (Postmark disqualified — won't sign
  a BAA). **B3 signed** — the messaging standard rendered into CLAUDE.md verbatim. **B6
  decided: (a)** — Handal front desk works recovered bookings from the Medibun staff schedule
  and mirrors to 4D until Phase H. Same session: R1's merge (PR #21) closes the B2 gate's
  first migration; **4D exports pricing** (Alec), so `service_categories` ticket values seed
  from the R0 export — expected-return intervals stay hand-set; toll-free is no longer the
  fast 10DLC fallback (4–6 weeks; corrected in BAA_CHECKLIST).
- 2026-08-13 — **Minduo defined (Alec)**: his other company, a consulting group unrelated to
  the practices — the group running the Medibun implementation, possibly the product's owning
  company (which one is settled in the BA agreement itself). It processes Handal PHI either
  way, hence the Minduo↔Handal BA agreement in `BAA_CHECKLIST.md`.
- 2026-08-13 — **Division of labor (Alec)**: sessions do development only; admin/paperwork is
  Alec's queue (`BAA_CHECKLIST.md`). Same day, also Alec's: the **cut-the-PRs-before-the-code**
  session rule added to CLAUDE.md's session hygiene (single-purpose PRs, named at session
  open). Parked for Alec: B3 signature (unamended CLAUDE.md rule
  governs meanwhile), B4 vendor pick (Twilio+SendGrid recommended; Resend disqualified — no
  BAA), tenant-hardening deadline. Engineering defaults adopted: R4
  pre-BAA verify = local stub channel; S4–S5.7 live-verify batch runs at R5 stack-up.
- 2026-08-13 — **Decided (Alec)**: data window ≥ 24 months (RECOVERY_DESIGN §2 governs); §10
  is two reads — preliminary ~W12 (early Go allowed), binding Go/Adjust/Kill at
  attribution-window close ~W17–18, never Kill on the preliminary; GFE does not bind R6
  (scoped exemption in ROADMAP — the floor stays hard for Aureva/new-injectable entry). The
  Vercel-vs-AWS platform question was answered separately: **no replatform** — Vercel stands.
- 2026-08-12 — **Doc-consistency pass applied** (Alec: "apply the fixes"): B2 tables land via
  per-slice approval-gated migration PRs (R1 staging · R2 `service_categories` · R5 ledger);
  R5 verify wording aligned to B8 (holdout enrolled with the immutable flag, zero touches);
  the §7 clock list gained 10DLC/Sentry/PostHog/DoseSpot rows (that list now lives in
  `BAA_CHECKLIST.md`); "Phase 3" → "Phase H"; cross-doc fixes in
  ROADMAP, RECOVERY_DESIGN, AUTH, V0/SCHEDULE/DATA_MODEL and the rules files.
- 2026-08-11 — **APPROVED (Alec), B-series decided**: B1 ✓ as written; B8 ✓ as drafted; B2 +
  B3 approved in principle (B2 walked at each migration PR; B3 diff signed explicitly at
  commit); B4 open — ADR-0005 with a real vendor evaluation on **BAA availability, pricing,
  STOP-handling webhooks, and 10DLC registration lead time** (Twilio + Postmark the original
  pair; SendGrid recommended over Postmark 2026-08-13), presented before any SDK lands; B5 open
  until its PR (Alec merges auth); B6 decide before R6; B7 Alec's, all clocks started at R0.
- 2026-08-11 — Proposed, from the strategy synthesis of the same date.
