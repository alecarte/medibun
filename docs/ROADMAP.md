# Roadmap

Seeded from `PROJECT_BRIEF.md` §5. Phase floor is set by **external dependencies** (BAA turnaround,
DoseSpot EPCS identity proofing, App Store review, 4D export quality, clinical validation), not
coding speed — so every paperwork clock starts on day one and runs in parallel with the build.

## Phase 0 — Foundation (weeks 1–3)

Core, auth, org model (Handal + Aureva). Start the slow paperwork **now**: BAAs (Medplum, Vercel,
comms, Sentry, PostHog), DoseSpot enrollment, Apple Developer. Verify 4D's export capability.

_Bootstrap status (2026-05-29):_ monorepo scaffold ✅ · CLAUDE.md ✅ · `.claude/` hardening ✅ ·
`/docs` stubs ✅ · Medplum wiring ✅ (self-hosted local dev; Subscription→Bot proven end to end).
All §6 bootstrap steps done. **Dev = self-hosted Medplum (`infra/medplum/`); prod = Medplum Cloud
later (needs BAA).** Outstanding paperwork: start the Medplum **BAA** clock + Cloud account for
Phase 1; DoseSpot enrollment; Apple Developer; verify 4D export.

## Phase 1 — Aureva launch (months 1–3)

Patient portal + patient app v0; Aureva clinical capture v1 in the staff app; owned online booking;
Stripe memberships. Handal stays on 4D. First real data work: the Aureva FHIR model
(`DATA_MODEL.md`) — ask before modeling.

## Phase 2 — Growth + experience (months 3–6)

QR check-in, geofence reminders, loyalty/packages, lifecycle automation on Bots, patient-app
polish. The "Starbucks for MedSpa" mechanics (loyalty, proactive recommendations) land here. No
external gate — pure build.

Added 2026-07-02 (competitive scan, approved by Alec — see `COMPETITIVE_NOTES.md`):

- **Before/after photos** (Media + the clinical-vs-marketing Consent split already modeled in
  `DATA_MODEL.md`) — first post-spine slice candidate; universal aesthetics table stake.
- **GFE / medical-director oversight** — good-faith-exam review + chart sign-off workflow for
  non-physician injectors (cf. Aesthetic Record "MD Rooms"). Compliance-adjacent: data-model
  amendment + approval gate when scheduled; **required before real (non-synthetic) operations**,
  wherever that lands relative to phases.

Added 2026-07-03 (booking-conversion research, approved by Alec — see `BOOKING_DESIGN.md` §4
for the full parked list with rationale). The post-v0 conversion levers, in rough order of
leverage:

- **Guest booking with SMS-code identity** (lands with the signup slice; folds into the
  deferred phone-OTP decision — AUTH.md review log). Biggest single new-patient friction lever.
- **Card-on-file hold at booking** with reassurance-worded policy (lands with Stripe; pairs
  with no-show fees + deposits already in the Phase-2 backlog).
- **Reminder cadence** (SMS/email, RCT-backed no-show reduction; comms vendor needs BAA) and
  **confirmation-to-arrival prep content** as its first touchpoint.
- **New-patient consultation-first entry** (the GFE requirement above, expressed as the booking
  flow's front door for new injectable patients — how every premium competitor does it).
- **Slot-ranking IP** (Boulevard-style calendar-packing availability ordering in the BFF) and
  **waitlist backfill** — growth-engine material, event-driven on Bots.
- **Funnel instrumentation** (lands with PostHog; BOOKING_DESIGN.md §5 lists the evidence gaps
  we owe ourselves A/B tests on).

## Phase 3 — Handal migration (months 6–10)

Surgical charting in the staff app, DoseSpot EPCS live, migrate history off 4D, retire it. EPCS is
heavily compliance-gated (DEA identity proofing IAL3, two-factor at signing) — approval-gated, not
a feature toggle.

## Phase 4 — Productize (12 months+)

Harden multi-tenant isolation; onboard a third practice under its own brand (brand = token set +
config, consuming the same platform API).

> **LICENSE (do at productization).** The repo is currently `UNLICENSED` (private, proprietary). As
> we productize / onboard external practices, add an explicit `LICENSE` file — likely "All Rights
> Reserved" proprietary, or a commercial license if the platform is sold to other practices. Decide
> deliberately at this phase. (Medplum itself remains Apache-2.0 as a dependency — unaffected.)

## Standing compliance gates (every phase)

Adding any PHI-touching vendor/dependency is a human-approval, BAA-gated decision. Stripe signs no
BAA → it never receives PHI. Unsure on HIPAA/access/audit → STOP and ask. See
`.claude/rules/security.md`.
