# Competitive notes — what leading EMR + aesthetics software has that we should weigh

Commissioned by Alec 2026-07-02 ("consider what else we'll need to pull from leading EMR and
aesthetics software that we may be missing"). Method: parallel web-research agents over Epic
(Cadence/Snapboard), ModMed EMA (derm/plastics), Tebra, DrChrono, healthcare kiosk/privacy
practice, plus an aesthetics-vendor sweep (Boulevard, Mangomint, Zenoti, Jane, Aesthetic Record,
PatientNow, Symplast, RepeatMD). **Provenance note:** several research branches were lost to API
rate limiting; findings below marked (cited) came back with sources; items marked (model
knowledge) come from the assistant's domain knowledge of these products and should be
spot-verified before being treated as load-bearing. This doc is an inventory + gap analysis, not
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
  safeguard.
- Kiosk check-in patterns (Phreesia/Clearwave/Epic Welcome): idle timeouts that clear sessions,
  narrow-viewing-angle screens, minimal-data prompts (Epic Welcome asks only last-2-digits of
  birth year). Relevant when we do lobby check-in (Phase 2 QR flow).

## 3. Aesthetics-platform table stakes (model knowledge — spot-verify)

Across Boulevard/Mangomint/Zenoti/Jane/Aesthetic Record/PatientNow/Symplast, the recurring set:

- **Charting**: face charts with drawable markup + photo annotation; consent capture on-device
  before treatment; treatment templates.
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
- **GFE / medical-director oversight** (aesthetics-specific compliance): non-physician injectors
  need a good-faith exam; platforms increasingly route async GFE review/sign-off to a supervising
  provider. Nothing in our model yet — needs a data-model + workflow decision before real
  operations (not demo-blocking).

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
