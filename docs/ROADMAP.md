# Roadmap

Rewritten 2026-08-11 with the v1 revenue re-cut (`V1_PROPOSAL.md`, supersedes the phase
sequence below the line in the 2026-05-29 version; Phase-0 bootstrap history preserved in git).
Phase floor remains set by **external dependencies** — now led by the BAA chain, which gates
_revenue_ (R6), not just launch. Every paperwork clock starts at R0 (V1 §7; the 10DLC clock
alone is downstream of the B4 vendor pick). Legend for older docs still using the 2026-05-29
numbering: Phase 1 ≈ L · Phase 2 ≈ G · Phase 3 ≈ H · Phase 4 ≈ P.

## Phase R — Revenue engine (weeks 1–7 build, campaign through ~W12)

The R-track (V1_PROPOSAL.md §5): 4D ingestion → Handal Leak Report → comms boundary → guest
booking → sequencer + attribution ledger + recovery queue → **engagement zero** at Handal with
holdout measurement against the §10 go/adjust/kill criteria (preliminary read ~W12; binding
decision at attribution-window close, ~W17–18). Real PHI runs local-only until
the BAA chain completes (RECOVERY_DESIGN.md §7). Stripe stays deferred; mobile stays stubbed;
the schedule family is frozen (V1 §4).

**Why first:** no Aureva date pressure; Handal's 4D data is the only real dataset; the
diagnostic + adapters are simultaneously the sellable wedge, the benchmark dataset, and the
Phase-H migration tooling.

## Phase L — Aureva launch spine (starts ~W7, overlapping the campaign; done ~W14–16)

The surviving V0 slices S6–S12, content and gates unchanged (V0 §8 demo script remains the
bar): AI boundary + ADR-0004 → face-map manual + ambient capture → history timeline →
patient concierge → staff assistant → demo polish. Plus the un-frozen launch prerequisites in
their V0 order: patient self-signup (now largely covered by R4's SMS identity), GFE /
medical-director oversight (**required before real (non-synthetic) operations, wherever that
lands relative to phases** — the original phase-independent floor, with one scoped exemption
decided by Alec 2026-08-13: **R6's recovered-booking operations at Handal do not trigger it**,
because R6 rebooks existing patients of a physician-led surgical practice under its own
medical oversight; the floor binds Aureva and any new-patient / new-injectable entry
unchanged), before/after photos (first post-spine candidate).

## Phase G — Growth + lab track (post-L, plus continuous Handal/Aureva lab work)

Two lanes, one spine:

- **Sold lane — lapse prevention:** the recovery engine's retention tail (maintenance-cadence
  nudges, rebooking proposals, waitlist backfill) productized for R-track customers; the
  growth-engine mechanics V0 deferred (old "Phase 2") land here _with a dollar frame_, on
  Bots/Subscriptions as originally designed. Commerce (Stripe memberships, card-on-file
  holds, deposits) joins this lane when a customer or Aureva's opening needs it.
- **Lab lane (Handal/Aureva only, feature-flagged, no multi-tenant polish):** loyalty,
  marketing, QR check-in, geofence, the guest **booking-overlay snippet** (PATIENT_SURFACE.md
  step 2 — unblocked once R4's guest identity ships) then embedded relationship components
  (step 3), consumer-app ambitions. Graduates to the sold lane only on customer pull
  (PROJECT_BRIEF amendment, V1 §8).

**Funnel instrumentation** (BOOKING_DESIGN.md §5's owed A/B evidence) lands with PostHog once
its BAA clears — it has no earlier scheduled home unless Alec pulls it into the R-track, so
engagement zero's booking funnel runs unmeasured by default (flagged, his call).

## Phase H — Handal migration (pullable forward)

Unchanged in content (surgical charting, DoseSpot EPCS, 4D history migration, retire 4D) but
no longer strictly sequential: **B6(a) — if chosen; the decision is owed before R6 (V1 §12) —
puts Handal's recovered-booking front office on Medibun during Phase R**, and the R1 4D
adapter is the migration's ingestion foundation — so Phase H becomes a staged widening (front
office → clinical) rather than a one-time cut-over. EPCS compliance gates unchanged; the
DoseSpot enrollment + DEA identity-proofing (IAL3) clock is months long and uncompressible —
it sits in V1 §7's day-one clock list and gates any pull-forward of prescribing. Bus-factor rule: Handal's _clinical_ record does not move while
the platform has a single-person sev-1 response.

## Phase P — Productize (gated on R6 = Go)

The external offer, in the memo's shape: paid Leak Report diagnostic → outcome-priced recovery
engagement → platform modules behind it. First external diagnostic triggers: the external-
tenancy ADR (separate Medplum Project vs closing the standing "before the second tenant"
hardening list), the LICENSE decision (standing note), pricing per the memo (diagnostic
$1.5–2.5K; ~$1.5K/mo base + per-recovered-appointment), and the adapter for whatever the
client runs (Boulevard/Zenoti/Pabau/AR/PatientNow, one at a time, on demand).

> **LICENSE (standing note — do at productization).** The repo is deliberately `UNLICENSED`
> (private, proprietary), not an oversight. At productization / first external practice, add
> an explicit `LICENSE` file — likely "All Rights Reserved" proprietary, or a commercial
> license if the platform is sold to other practices. Decide deliberately at this phase.
> (Medplum itself remains Apache-2.0 as a dependency — unaffected.)

## Standing compliance gates (every phase — unchanged)

Adding any PHI-touching vendor/dependency is a human-approval, BAA-gated decision. Stripe
signs no BAA → it never receives PHI. Outbound messages follow the B3 messaging standard.
Unsure on HIPAA/access/audit → STOP and ask. See `.claude/rules/security.md`.

## Standing pre-external-tenant hardening list (carry-forward)

Org-scope the unscoped operational reads; org-scope the check-in Bot's Encounter write;
tenant-scope move-up queries; validate `slot[]` schedule ownership once the $book slot-ref
live-verify lands; move-up `resolvedBy` attribution. Owed **before Handal — the second
tenant — shares the Project** (the firm deadline recorded at the S5.7 security review;
canonical list + deadline live in DATA_MODEL.md's AccessPolicy notes), and before any
external tenant regardless; the separate-Project ADR (V1 §8) moots it only for external
clients, never for Handal.

## Live-verify debt (carry-forward, schedule at R6 prod stand-up)

The accumulated "live verify owed on a real stack" items from S4–S5.7 run as one batch when
the prod stack stands up for R6 — booking $book participant/serviceType/slot-ref behavior,
`meta.accounts` propagation, versionId test-and-set honoring, staff policy denials, two-station
polling. Recorded per-slice in V0 §9; check them off there.
