# Recovery engine — design

**Status: APPROVED with `V1_PROPOSAL.md` (Alec, 2026-08-11). Per-gate decision states live
in V1 §12 — the single source for gate state; note B4 gates on the ADR-0005 decision before
any SDK lands (not a PR), and B5 at its PR. This is the binding companion for the R-track,
in the pattern of BOOKING_DESIGN.md / SCHEDULE_DESIGN.md: decisions here are implemented as
written; changes land in the review log.**

The engine sells one outcome: **appointments the practice was already losing, recovered and
attributed.** Three subsystems: ingestion (§2–3), the sequencer + queue (§4–6), and the
attribution ledger (§9). Design register: staff surfaces stay quiet-tool; patient touchpoints
inherit the premium-consumer booking register (BOOKING_DESIGN.md) — a recovery link must land
on the best booking flow the patient has ever used, or the touch is wasted.

## 1. The three pools

| Pool                              | Definition (operational)                                                                               | Data required                                       | Cadence character                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Dormant / lapsed**              | Last completed visit older than the service category's expected-return interval; no future appointment | Patients + appointment history + category intervals | Slow (weekly snapshots fine)                                                                      |
| **Unconverted consults**          | Consult-category visit completed, no subsequent booking within N days                                  | Appointment history w/ categories                   | Slow–medium                                                                                       |
| **Missed / non-booked inquiries** | Inbound inquiry with no appointment within M days and no logged follow-up                              | Call logs / inquiry records                         | Fast (the commoditized pool — last priority; may simply ingest an AI-receptionist's output later) |

v1 (engagement zero) targets the **dormant pool** first: biggest, slowest-moving, cleanest to
attribute, and fully covered by a 4D export. The other pools activate as R0's data assessment
permits.

## 2. Ingestion — adapters over interoperability

No FHIR-mapping of imports; no universal connector ambitions. A `SourceAdapter` interface
(parse → validated staging rows + rejects report), one adapter per source system, built only
when an engagement demands it. **4D CSV is adapter #1** and doubles as the Phase-H migration
foundation. Re-import is idempotent by (source system, source row identity); every import runs
under an `imports` row recording file hashes, counts, and rejects — the reconciliation
evidence for attribution disputes.

**R0 shopping list (Handal / 4D):** patient roster (name, DOB, phone, email, patient id);
appointment history ≥ 24 months (patient id, datetime, status, service/category, provider);
inquiry/call records if 4D or the phone system logs them; consult outcomes if distinguishable;
the practice's service menu with typical ticket values (financial config, entered by hand if
not exportable).

## 3. Data model (gate B2)

**Two-store rule, respected by construction:** staging and the ledger hold
**administrative + financial** data only — identity, contact, appointment _times/statuses/
service category_, inquiry outcomes, ticket values. Clinical content (what was treated, why,
outcomes) never enters the experience DB; the engine never needs it. PHI-bearing _message
content_ lives clinical-side as `Communication` (below).

Experience DB (Drizzle migrations, A6/B2 discipline):

- `imports` — id, source_system, file_hash, counts, rejects_uri, created_at.
- `staged_patients` / `staged_appointments` / `staged_inquiries` / `staged_consults` — flat,
  `source_system` + `source_identity` keyed, import-versioned. Staged patients link to a
  Medplum `Patient` id once promoted (identity promotion is the _only_ Medplum write ingestion
  makes; org-tagged; deduped by name+DOB+phone with a manual-merge queue for collisions —
  identity is durable from day one, per the platform plan).
- `service_categories` — code, display, expected_return_interval_days, typical_ticket_cents,
  ticket_basis (financial config; feeds segmentation + report math, and the basis marker is what
  the report's methodology note prints).
- `staged_transactions` (**proposed at the R2a walkthrough**) — the revenue export's rows:
  derived row identity, patient source id, date, raw category, amount in cents. Dormancy's
  primary signal is the last _paid_ visit per patient per category, so these rows are queried,
  not averaged once (review log, 2026-08-14). No line-item description column, ever.
- `campaigns` — pool type, practice org, cadence config, attribution_window_days,
  holdout_pct, status; **pool snapshot + holdout assignment are immutable at enrollment**.
- `enrollments` — (campaign, patient) with state (§4), holdout flag, exclusion reason.
- `touches` — enrollment, step #, channel, template code + params (PHI-minimal by B3),
  vendor message id, sent/delivered/failed timestamps, Medplum Communication id.
- `recoveries` — enrollment, appointment id (Medplum), `booked_at`, `first_visit_value_cents`,
  attribution basis (which touch, token id), report period. Append-only; corrections are new
  rows with reversal links, never updates — this table _is_ the invoice evidence.

Medplum (clinical side): promoted `Patient` (org-tagged); one **`Communication`** per sent
touch (sender = org, recipient = patient, payload = rendered body, `basedOn` linkage) — the
auditable PHI record; the recovered `Appointment` itself via the normal S4 path. New
CodeSystems: `…/recovery-pools`, `…/outreach-templates`.

## 4. Sequencer

State machine per enrollment: `enrolled → in_sequence(step n) → responded | booked →
recovered | opted_out | excluded | exhausted`. Transitions only via: queue approval (send),
vendor webhooks (delivery/STOP), inbound reply, booking events (token match), refresh imports
(a patient who rebooked through any other channel → `excluded`, never contacted again —
honesty is the product). Cadence per campaign config (default dormant: 4 touches over 5 weeks,
SMS-led with one email); **quiet hours + practice-local time enforced in the sequencer, not
the templates**; hard stops: STOP/opt-out (immediate, channel-wide), `excluded`, campaign end.

## 5. Messaging standard (gate B3 — constitution clarification)

Outbound bodies: at most **first name + practice name + one opaque link**; **never** clinical,
treatment, visit-reason, or health-status content; every body renders from the reviewed
template library (no free-text sends in v1); links are single-patient, short-lived, opaque
tokens (token rules: `AUTH.md`'s B5/R4 entry is the authoritative home — issuance only by the
sequencer/BFF, enumeration-safe, rate-limited, expired/reused fail closed; the full spec
lands with R4); STOP language on first SMS touch per campaign. Templates are content, not
code — reviewed like copy (DESIGN.md voice rules apply), versioned by code in `touches`.
Signed into CLAUDE.md 2026-08-13 (B3, Alec) — this section is operative.

## 6. The recovery queue (`/recovery`, staff app)

The operational thesis rendered as one screen: **today's approvals, four minutes, done.**
Oldest-first list of drafted touches (patient masked-aware per lib/privacy), each card:
patient, pool, step, drafted body (template + params), approve / edit-params / skip /
remove-from-campaign. Batch-approve for identical templates. v1 sends **nothing** without a
human approval (per-campaign automation level is a later config, not a v1 behavior). Keyboard-
first like the schedule; empty state shows campaign health (enrolled / in-flight / recovered
this week). No campaign-builder surface — campaigns are config created by Fable sessions with
Alec until there's a reason for UI.

## 7. Real-PHI handling before the BAA chain (binding runbook)

Until every touched cloud service has its BAA: real exports and real staging live **only** on
practice-controlled hardware (Alec's machine against the local docker stack); raw exports are
never committed, never uploaded, never pasted into cloud tools; fixtures and seeds are
synthetic-only (existing rule, restated); the Leak Report is generated locally and delivered
directly. The import CLI must therefore run fully local (it already will — local stack +
local Postgres). Cloud promotion of real data is a single explicit cut-over once every BAA
required for the touched services is signed (`docs/BAA_CHECKLIST.md` rows — the all-signed
release rule stated there and in `security.md`), recorded in this review log.

**Cut-over checklist (added as items are found):** BAAs signed for every touched service ·
**import actor attribution** — `imports` records what ran, not who ran it, which is tolerable
for one operator on one machine but not once an endpoint, a second person, or a hosted stack can
trigger an import (an actor column lands before any of those, per CLAUDE.md's "every PHI write
attributable to an authenticated principal").

## 8. Write-back at Handal (gate B6 — **decided: (a)**, Alec 2026-08-13, V1 §12)

Recovered bookings land in Medibun (Medplum is booking's source of truth by construction).
Until Phase H retires 4D:

- **(a) Recommended:** Handal front desk works recovered bookings from the Medibun staff
  schedule (already built, already polished) and mirrors them into 4D as their normal entry
  workflow. Medibun is authoritative for _recovered_ appointments; 4D remains authoritative
  for everything else. The weekly report reconciles.
- **(b) Fallback:** booking-request mode — the guest flow captures the request; front desk
  confirms + enters in 4D; Medibun marks recovered on confirmation. Lower tech risk, worse
  patient experience (not one-tap-done), weaker attribution timestamps.

Either way the double-booking exposure is bounded: recovered bookings use `$find` against
Medibun schedules that front desk maintains for recovery windows; a conflict with a 4D-side
booking surfaces at mirror time and is resolved by the desk (accepted, logged, reviewed at
the week-2 checkpoint).

## 9. Attribution — the asset

The B8 definition, implemented verbatim, quoted verbatim in every report. Chain required for a
`recoveries` row: enrollment (non-holdout) → approved touch → token issued → token-bound
booking (or coded manual attribution by the desk for phone-back responses, marked as such).
Weekly report per campaign: sends/deliveries/opt-outs, responses, bookings, recovered count +
first-visit value, holdout comparison, exclusions honesty section ("N patients rebooked on
their own and were never contacted"). Report format is itself a deliverable — it becomes the
external client's weekly artifact unchanged.

## 10. Explicitly out of v1

LLM-drafted message bodies (templates suffice; revisit post-Anthropic-BAA) · voice outreach ·
the inquiry pool's real-time speed-to-lead race (commoditized; resell/ingest later) ·
campaign-builder UI · automation levels above approve-every-touch · external-client tenancy
(separate-Project ADR when the first sale exists) · any COGS/commission/financial-OS scope
(Atrium remains a separate venture).

## Review log

- 2026-08-14 — **R2a built, at the B2 gate: §3's schema, corrected by R0 (PENDING Alec's
  walkthrough + merge).** Migration `0004` carries what R2 segmentation needs and nothing else:
  **`service_categories`** as designed here (code slugged from 4D's own coded Category taxonomy,
  display verbatim, `expected_return_interval_days` **hand-set** — clinical-cadence judgment,
  never derived, and null for a category that defines no dormancy such as retail —
  `typical_ticket_cents` null until seeded, plus a `ticket_basis` methodology marker so the Leak
  Report can state where each number came from); the **R0 corrections** to `staged_appointments`
  (no patient id, no status in the real export → both nullable, name+DOB+phone staged as the
  roster join keys) and `staged_consults` (Conversion By Provider: name only, quote number as row
  identity, a date not an instant, quoted dollars, booked/completed as raw labels); and
  `staged_patients.spend_cents` + `phone_type`. Allergy/Description remain excluded by
  construction — no column exists for them.
  **The decision this walkthrough is really for: `staged_transactions`.** The 2026-08-14 entry
  below parked "rather than a new staged-transactions table, compute per-category averages
  locally" — and the same day's finding that **dormancy computes primarily from Revenue rows**
  (last _paid_ visit per patient per category) makes those rows a queryable input, not a
  statistic. So the table is proposed here: derived row identity (the Revenue CSV has no row id —
  sha256 of the normalized identifying fields plus an occurrence suffix, owned by the adapter),
  patient id (R0 win (a)), date, raw category, amount in cents (negative = refund), and
  **deliberately no line-item description** — that column is operator-typed and can carry
  visit-reason-adjacent text, so it is excluded by construction like Allergy/Description.
  Declining the table means dormancy falls back to the appointment export alone, which has no
  status column. Verified on synthetic fixtures through the PGlite round-trip suites; the 4D
  header maps stay provisional (the report-layout normalization pre-pass and the derived
  identities are the next PR). Carried in: the `*_raw` allow-list verdict (signal favorable, never
  explicitly recorded at R0's close) and import-actor attribution (§7 checklist).
- 2026-08-14 — **R0 CLOSED (Alec).** The two remaining items resolved: **(1)** the Non-VIP
  filter is moot — Handal has no patients marked VIP, so the 22,541-row Patient Export is the
  full roster; no re-pull needed. **(2)** Conversion By Provider CSV header received: consult
  date (A), patient **name only — no patient-ID column** (D), quote number (G), provider (I),
  coordinator (N), procedure (O), quote amount (R), booked (T), completed (W), days-to-book
  (Y). Consequences: consult rows join the roster **by name alone** (this file carries no
  DOB/phone) — ambiguous name matches are flagged for manual resolution, never guessed; the
  **quote number serves as the row's source identity** for idempotent re-import. One more
  normalizer datum: the duplicated mid-file title line can differ from the report's own name
  ("Quote Acceptance…" inside "Conversion…") — decoration rows are recognized structurally,
  not by title text. **R0's verify step is met**: field mapping recorded across this entry
  and the two below; pools marked dormant **feasible**, unconverted consults **feasible
  (degraded)**, inquiries **infeasible at Handal**. Real-data verification of R1 (counts
  reconciled against the in-file 4D totals) runs at the first local import once the adapter
  normalization pass lands.
- 2026-08-14 — **CSV shape confirmed (Alec; header-region screenshots of 5 exports): the
  CSVs are report-layout dumps, not clean tables.** Shared shape: preamble rows (practice
  name, report title, filters, date range), a duplicated title row mid-file, **provider
  section rows** as group headers, **day-separator rows** (appointment list), `Total X = N`
  rows, and values scattered across sparse spreadsheet columns; the Product List additionally
  nests price-option **sub-rows under a two-row header**. Adapter consequence (the planned
  R0→R1 correction, no schema change): a **normalization pre-pass** — locate the real header
  row, skip decoration rows, carry provider/day group context down onto data rows — ahead of
  the existing declarative column map; synthetic fixtures reshaped to the real layout.
  Two wins in the real headers: **(a) the Revenue CSV carries a patient `Id` column** absent
  from its print view — dormancy joins by ID, no name-matching needed on the money signal
  (name+DOB+phone matching remains for the appointment file, which confirms it has no ID or
  status column); **(b) the embedded `Total = N` rows give each file its own reconciliation
  total** — R1's "counts reconciled against 4D's own totals" verify can run per-file with no
  side channel. Revenue re-pull at the full 8/14/2024–8/14/2026 range: **done** (visible in
  the header region). Remaining R0 closure: the **Conversion By Provider CSV header region**
  (its patient-Id question is the last mapping unknown) and the unfiltered patient re-pull.
- 2026-08-14 — **R0 export set complete — assessment closed pending CSV headers (Alec).**
  Third drop: **(9) Detailed Appointment List — All Calendars** (print view: date+time,
  provider, patient name, DOB, age, phone, **Allergy**, Appt Type/Location, **Description**
  free text, created date). Findings, binding on the R1 adapter:
  **(i) `Allergy` and `Description` are never staged** — Allergy is clinical content;
  Description is operator free text that can carry visit reasons. Neither is needed (Appt
  Type is the category signal); the adapter drops both columns on read. This is the two-store
  rule's first live test and the answer is exclusion by construction.
  **(ii)** No patient-ID or status column **in the print view**; DOB+phone present → roster
  join runs on name+DOB+phone. 4D demonstrably has statuses internally (the Conversion
  report filters on "Completed") — whether the CSV export carries them is the last open
  mapping question; Alec sends the **header row only** of each CSV to close it.
  **(iii)** Dormancy computes primarily from **Revenue rows** (last _paid_ visit per patient
  per category — a completed-visit signal at least as strong as an appointment status), with
  the appointment export supplying the no-future-booking half of the definition; if the CSV
  turns out to carry status, that's an upgrade, not a dependency.
  **(iv)** Non-patient calendar blocks ("Happening", patient `#`) exist in the export — the
  adapter filters rows without a real patient.
  **Format confirmed: all exports are CSVs on practice hardware** (screenshots were
  print-view convenience only). **Final pool verdicts — dormant: feasible** (revenue-driven,
  per iii); **unconverted consults: feasible** (degraded: quote-created, surgical only);
  **inquiries: infeasible at Handal** — 4D doesn't track them; pool parked (anticipated by
  §1's "may simply ingest an AI-receptionist's output later"; `staged_inquiries` stays
  unused for engagement zero). Remaining R0 closure items: CSV header rows (above),
  unfiltered patient re-pull, full-range revenue re-pull.
- 2026-08-14 — **R0 first drop assessed (Alec; report-structure screenshots only — no
  patient rows entered any cloud tool; raw exports stay on practice hardware per §7).**
  Five 4D reports, all "Handal Plastic Surgery":
  **(1) Conversion By Provider** (range set 8/14/2024–8/14/2026): consult date, patient,
  quote, provider, coordinator, procedure, **quote amount**, booked, completed, days-to-book —
  the unconverted-consults pool pre-built, valued by actual quoted dollars rather than
  category averages. Self-declared limits: quote-created consults only, "Completed" consult
  status only, excludes "Spa" quotes (surgical-consult pool specifically); patient-ID column
  unconfirmed (name+DOB match against the roster is the fallback join).
  **(2) Surgery Conversion by Month**: aggregate only — not ingestible; kept as 4D's own
  totals for the R1/R2 reconciliation checks.
  **(3) Patient Export**: first/last name, **ID**, DOB, email, phone, phone type, address
  fields, **Spend** (per-patient historical spend — dormant-pool value weighting); header
  truncated after Spend — full list owed. Ran under a "Non-VIP patients" filter (count
  22,541) — **re-pull unfiltered** (VIP-tagged patients are prime re-engagement candidates).
  Address columns won't be staged (data minimization; `staged_patients` takes identity +
  contact only).
  **(4) Procedure List** (92 procedures/provider: name, duration, surgeon fee, supply fee,
  total) + **(5) Package List** (spa/injectable packages with unit cost/value): the priced
  service menu — `service_categories` ticket seeds. Methodology note for the Leak Report:
  prices exclude anesthesia/facility fees → surgical ticket values are deliberately
  conservative.
  **Coded-label signal favorable** (menu-driven procedures; coded "Completed" status) — the
  R1 `*_raw` allow-list question stays open until the appointment export confirms.
  **Second drop, same day**: **(6) Product List** (160 retail products: name, **code** e.g.
  `GAR_3PN`, manufacturer, **Category** e.g. "Garments", Report Tag, price options) — retail
  is outside the leak math, but it reveals 4D's **coded Category + Report Tag taxonomy with
  short codes**, the mapping source for `service_categories`. **(7) Services List** (82
  services/provider: name, commission, **total fee** — e.g. a $3,500 package) — the
  non-surgical/spa priced menu, completing the service menu alongside (4)/(5); same
  anesthesia/facility-fee exclusion. **(8) Revenue by Staff Incl. Procedure Prepayments**
  (date-ranged, row-level): DOS/paid date, patient first/last name, description, **Category**,
  Report Tag, amount — run over the full ≥24 months this yields **actual average ticket per
  category**, superseding list prices for the Leak Report math. R2 design note: rather than a
  new staged-transactions table (a B2 schema addition), the default is to compute per-category
  averages from this export locally and record them into `service_categories` with the
  methodology noted — decide at the R2a schema walkthrough.
  The shared coded Category taxonomy across (6)–(8) further strengthens the coded-label
  verdict; final confirmation still rides on the appointment export.
  **Pool verdicts so far**: unconverted consults **feasible** (degraded to quote-created +
  surgical only); dormant **pending** — the ≥24-month Scheduler appointment-history export
  (patient id, datetime, status, type, provider) is the missing spine; inquiries **unknown**
  (Marketing-menu tracking unconfirmed). Export format (CSV vs print-only) unconfirmed for
  all eight — R1's adapter expects CSV.
- 2026-08-13 — **R1 merged (PR #21, Alec)**: the B2 gate's first migration (the §3 staging
  tables) is approved per the gate's own rule — Alec walked the schema and merged. The two
  carried items below (the `*_raw` allow-list question → R0; import-actor attribution → §7
  cut-over checklist) remain open. Same day: 4D **does** export pricing, per Alec — the R0
  pull includes the service menu with prices, and R2's `service_categories.typical_ticket_cents`
  seeds from the export rather than hand entry (expected-return intervals stay hand-set —
  they're clinical-cadence judgment, not export data). ADR-0005 (B4) drafted with the vendor
  evaluation; decision states in V1 §12.
- 2026-08-12 — **R1 built, at its gate**: the §3 staging tables (`imports` + the four
  `staged_*`) are proposed as the B2 gate's first migration — approved when Alec walks the
  schema and merges the R1 PR, not before — with the §2 `SourceAdapter` contract, the 4D CSV
  adapter as adapter #1, and a local-only import CLI (`pnpm --filter @medibun/api import:4d`)
  writing a row-level rejects file. §7's local-only runbook is satisfied by construction (a file
  on disk, the local Postgres, nothing else), and raw exports plus `*.rejects.csv` are
  gitignored as a backstop. Verified on synthetic 4D-shaped fixtures only; the 4D headers and
  the inquiry/consult columns stay provisional until R0's field mapping. No Medplum write and no
  HTTP surface in R1. Two items carried forward: **(R0)** confirm the source's
  category/status/outcome/channel fields are coded labels — if any is free text an operator can
  type into, the adapter must map it through an allow-list rather than staging it verbatim, or
  the two-store rule stops holding; **(§7 cut-over checklist)** `imports` records what ran, not
  **who** ran it — an actor column is required before any HTTP import surface, a second
  operator, or cloud promotion. Tables + reconciliation keys are documented in `DATA_MODEL.md`
  ("Recovery staging (R1)").
- 2026-08-12 — Doc-consistency pass (code review; Alec: "apply the fixes"): status header
  slimmed to the V1 §12 pointer with the B4 gate stated correctly (ADR decision, not a PR);
  §5's dangling "(§below)" now points at AUTH.md as the token rules' authoritative home and
  §5 carries the interim-precedence note (CLAUDE.md governs until the B3 diff is signed);
  "Phase 3" → "Phase H" (§2, §8).
- 2026-08-11 — Approved with V1_PROPOSAL.md (B-series decision states recorded in its §12):
  §9/B8 approved as drafted; §3/B2 and §5/B3 approved in principle — each still individually
  signed by Alec (the migration PR walkthrough and the CLAUDE.md diff respectively); the §7
  local-only runbook is binding until Alec records the BAA-chain cut-over here; §8/B6 decided
  before R6; ADR-0005 (B4) and guest identity (B5) land at their own gates.
- 2026-08-11 — Proposed with V1_PROPOSAL.md.
