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
- `service_categories` — code, display, expected_return_interval_days, typical_ticket_cents
  (financial config; feeds segmentation + report math).
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
Until Alec signs the B3 CLAUDE.md amendment, CLAUDE.md's unamended "PHI never in SMS bodies"
rule governs any implementation — this section becomes operative with that signature.

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
local Postgres). Cloud promotion of real data is a single explicit cut-over once §7 of the
proposal clears, recorded in this review log.

## 8. Write-back at Handal (gate B6 — decide before R6)

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

- 2026-08-12 — **R1 shipped**: the §3 staging tables (`imports` + the four `staged_*`) landed as
  the B2 gate's first migration, with the §2 `SourceAdapter` contract, the 4D CSV adapter as
  adapter #1, and a local-only import CLI (`pnpm --filter @medibun/api import:4d`) writing a
  row-level rejects file — §7's local-only runbook satisfied by construction. Verified on
  synthetic 4D-shaped fixtures only; the 4D headers and the inquiry/consult columns stay
  provisional until R0's field mapping. No Medplum write and no HTTP surface in R1. Tables +
  reconciliation keys are documented in `DATA_MODEL.md` ("Recovery staging (R1)").
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
