# Data model

Seeded from `PROJECT_BRIEF.md`. The Aureva model below is **v1 DRAFT — pending Alec's review**
(Sprint 01, goal 5; this document is the "ask before modeling" artifact). Nothing below is
implemented; no code is written against this model until the draft is accepted.

## Two stores, one reconciliation key

|               | **Medplum (clinical)**                                                           | **Our DB (experience)**                                                          |
| ------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Owns          | FHIR clinical record — the source of truth                                       | Non-clinical experience data                                                     |
| Examples      | Patient, Practitioner, Encounter, Observation, consents, charting, prescriptions | Memberships, loyalty/rewards, app preferences, push tokens, growth-journey state |
| Accessed via  | The BFF only (server-side Medplum SDK)                                           | The BFF (its own database — Neon + Drizzle, ADR-0002)                            |
| Reconciled by | **patient ID** ←──────────────────────────→ **patient ID**                       |                                                                                  |

Rule: clinical data never moves into the experience DB and vice versa; they reference each other by
ID. PHI lives in Medplum (and transiently in the BFF), never in client storage, logs, analytics, or
Stripe. See `.claude/rules/{security,fhir}.md`.

The Medplum side runs self-hosted locally for dev (`infra/medplum/`) and on Medplum Cloud for prod
later; the SDK lives only in `packages/medplum-backend`. See `docs/ARCHITECTURE.md`.

## Multi-tenant (Handal + Aureva) — DECIDED

**One Medplum Project, parameterized AccessPolicies** — see `docs/adr/0003-multi-tenancy.md`
(Accepted 2026-06-11). `Organization` per practice; every clinical resource tagged with its owning
practice at write time; access via Organization-parameterized AccessPolicy templates bound through
`ProjectMembership`. Least-privilege, default-deny; policy widening is approval-gated.

## Aureva FHIR model — v1 DRAFT (pending review)

### Org & people

| Concept  | Resource                                 | Notes                                                                   |
| -------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| Practice | `Organization` (`org-aureva`)            | Tenancy anchor (ADR-0003).                                              |
| Site     | `Location` (managed by the Organization) | One per physical site.                                                  |
| Staff    | `Practitioner` + `PractitionerRole`      | Role binds practitioner ⇄ org ⇄ specialty; shared staff = role per org. |
| Patient  | `Patient` (core-wide)                    | One record across practices. Cross-practice visibility: see open Q1.    |
| Visit    | `Encounter`                              | One per appointment-turned-visit; everything clinical hangs off it.     |

### Booking (owned online booking, Phase 1)

- `Schedule` (per practitioner+location) → `Slot` → `Appointment`. Standard FHIR scheduling; the
  BFF owns the booking UX and writes `Appointment` (status `proposed`→`booked`); a Bot handles
  confirmations/reminders on Subscription.
- **Service menu lives in the experience DB** (names, durations, prices, Stripe product ids — no
  PHI, freely editable). Each service row carries a code from our CodeSystem
  `https://medibun.com/fhir/CodeSystem/services`, which is what appears in
  `Appointment.serviceType` / `Procedure.code`. Price never enters FHIR; what-was-performed never
  lives only in the experience DB.

### Clinical capture v1 — injectables (the flagship Aureva workflow)

- **`MedicationAdministration` per product per injection site** — neurotoxin/filler administration
  is literally medication administration: `dosage.dose` (units), `dosage.site` (SNOMED body site),
  `medication` → `Medication` with `batch.lotNumber`. Grouped under a `Procedure` (the treatment,
  e.g. "Botox treatment") within the `Encounter`.
- **Injection-map coordinates** (the tap-on-face diagram): custom extension on
  `MedicationAdministration.dosage` —
  `https://medibun.com/fhir/StructureDefinition/injection-point` carrying normalized `{x, y, view}`
  (view ∈ front/left/right/back). **Rationale for the extension:** FHIR has no element for 2D
  diagram coordinates; SNOMED body sites stay the semantic truth, the extension is presentation
  geometry only.
- **Clinical photos**: `Media` (+ `Binary`) linked to the Encounter; capture/use gated on the photo
  `Consent`. PHI: same handling as any clinical resource.

### Treatment series (packages of N sessions)

- **Clinical progress → FHIR `CarePlan`** per series (e.g. "laser hair removal ×6"): activities
  reference the scheduled `Appointment`s / performed `Procedure`s; status tracks the series.
- **Commercial state → experience DB** `package` table (patient id, care-plan id, sessions
  purchased/remaining, Stripe payment refs). The split: what happened to the body is FHIR; what
  was bought and what's left is experience data. Reconciled by patient id + care-plan id.

### Consents

- `Consent` per consent type (treatment, photo/media use, financial policy), with
  `sourceReference` → `DocumentReference`/`Binary` (the signed artifact) and `provision.period`
  for validity. Intake/medical-history forms: versioned `Questionnaire` definitions +
  `QuestionnaireResponse` per submission.
- Later (not v1): a Bot that flags clinical capture lacking an active treatment Consent.

### Memberships & loyalty

- **Entirely experience data + Stripe.** `membership` table (patient id, tier, status,
  `stripe_customer_id`, `stripe_subscription_id`); loyalty ledger likewise. Nothing in FHIR at v1
  (no clinical eligibility semantics yet).
- **Stripe hard constraint** (CLAUDE.md): generic product names ("Aureva Membership"), no
  patient/diagnosis/service context in metadata/descriptors/customer fields. See open Q4 on the
  minimum customer identity Stripe needs.

### AccessPolicy & audit expectations (per resource family)

| Resource family                                | Patient (self)         | Front desk (org-scoped) | Clinician (org-scoped) | Audit                        |
| ---------------------------------------------- | ---------------------- | ----------------------- | ---------------------- | ---------------------------- |
| Patient demographics                           | read/update-some       | read/write              | read                   | AuditEvent on, all access    |
| Appointment/Schedule/Slot                      | read own, book via BFF | read/write              | read/write             | AuditEvent on                |
| Encounter, Procedure, MedicationAdministration | read own (summary)     | —                       | read/write             | AuditEvent on                |
| Media (photos)                                 | read own               | —                       | read/write             | AuditEvent on, consent-gated |
| Consent, QuestionnaireResponse                 | read/create own        | read                    | read/write             | AuditEvent on                |

Default-deny everything else. Policies are **templates parameterized by Organization** (ADR-0003);
no hand-rolled per-user policies. Every policy lands via reviewed code (Medplum CLI), never the
admin UI, and goes through security-reviewer.

### Open questions (resolve at review)

1. **Cross-practice visibility:** shared `Patient` demographics for both practices — but should
   Aureva clinicians see Handal surgical history by default? Proposed default: **no** (org-scoped
   clinical reads; demographics shared), with an explicit break-glass path later.
2. **MedicationAdministration vs Observation** for injectables — MA proposed above for semantic
   fidelity; confirm against the actual clinician charting workflow before locking.
3. **Injection-point extension shape** — `{x, y, view}` normalized to a canonical face diagram;
   needs the staff-app canvas design to validate.
4. **Stripe customer identity minimum** — proposal: email only (receipts) + generic product names;
   confirm this satisfies receipts/disputes without leaking patronage context.
5. **Photo retention/size policy** — Binary storage budget and retention schedule, before photos
   ship.

## Migration (Handal off 4D) — later

Phase 3. One-time cut-over from the 4D EMR; verify 4D export capability early (Phase 0 paperwork).
History migration + retirement of 4D. Out of scope until then.
