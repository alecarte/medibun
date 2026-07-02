# Data model

Seeded from `PROJECT_BRIEF.md`. The Aureva model below is **v1 — validated and accepted
2026-06-11** (Sprint 01, goal 5). It was adversarially reviewed against the FHIR R4 spec and
Medplum 5.1.x docs; corrections from that review are incorporated. Nothing below is implemented
yet; implementation follows the normal PR + security-reviewer discipline.

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
(Accepted 2026-06-11). Mechanics (verified against Medplum docs):

- `Organization` per practice; clinical resources carry the owning practice in **`meta.accounts`**
  (plural — the current field; singular `meta.account` is legacy).
- Policy criteria use Medplum parameter substitution (e.g.
  `Patient?_compartment=%organization`), with `ProjectMembership.access[].parameter[]` supplying
  the Organization per membership. Least-privilege, default-deny; widening is approval-gated.
- **Tagging mechanics:** only project admins can write `meta.accounts` directly; the supported
  mutation path is the `$set-accounts` operation. Account tags auto-propagate only for resources
  in the **Patient compartment**; non-patient-compartment resources (Schedule, Location, …) need
  explicit tagging or criteria-based scoping. The BFF's ClientApplication therefore needs the
  rights to set accounts — granting that is itself an approval-gated access decision.

## Aureva FHIR model — v1 (accepted 2026-06-11)

### Org & people

| Concept  | Resource                                 | Notes                                                                   |
| -------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| Practice | `Organization` (`org-aureva`)            | Tenancy anchor (ADR-0003).                                              |
| Site     | `Location` (managed by the Organization) | One per physical site.                                                  |
| Staff    | `Practitioner` + `PractitionerRole`      | Role binds practitioner ⇄ org ⇄ specialty; shared staff = role per org. |
| Patient  | `Patient` (core-wide)                    | One record across practices. Visibility: decided, see below.            |
| Visit    | `Encounter`                              | One per appointment-turned-visit; everything clinical hangs off it.     |

**Cross-practice visibility (decided):** demographics shared; clinical history **org-siloed by
default** (Aureva staff do not see Handal surgical records). An explicit break-glass path can come
later as its own approval-gated design.

### Booking (owned online booking, Phase 1)

- Use **Medplum's scheduling operations** — `$find` / `$hold` / `$book` / `$confirm` / `$cancel` —
  rather than raw `Appointment`/`Slot` writes. Slots are _synthetic_ (computed on demand from the
  Schedule's availability) and `$book` creates the Appointment + busy Slot atomically, so Medplum
  owns double-booking prevention.
- Medplum constraint: a `Schedule` has **exactly one actor** (the `Practitioner`, with the
  timezone extension); location is carried on the Appointment, not as a second Schedule actor.
  Note: Medplum's availability definition is currently **Alpha** — track it as a dependency risk.
- **Service menu lives in the experience DB** (names, durations, prices, Stripe product ids — no
  PHI, freely editable). Each service row carries a code from our CodeSystem
  `https://medibun.com/fhir/CodeSystem/services`, used in `Appointment.serviceType` (CodeableConcept,
  example binding — custom CodeSystem is conformant) and `Procedure.code`. Price never enters
  FHIR; what-was-performed never lives only in the experience DB.

### Clinical capture v1 — injectables (the flagship Aureva workflow)

- **`MedicationAdministration` per product per injection site**: `status: completed` (required),
  `subject` → Patient (required), `effectiveDateTime` (required), `dosage.dose` (units),
  `dosage.site` (SNOMED body site), `dosage.route`, **`partOf` → `Procedure`** (the treatment,
  e.g. "Botox treatment") and `context` → `Encounter`.
- **Lot tracking:** `medication` → a standalone `Medication` per **product + lot**
  (`batch.lotNumber`), not per product — one shared per-product resource would corrupt lot history
  across administrations, and standalone per-lot resources keep recalls searchable via the
  standard `lot-number` search parameter ("which patients received lot X").
- **Injection-map coordinates** (the tap-on-face diagram): complex extension on
  `MedicationAdministration.dosage` —
  `https://medibun.com/fhir/StructureDefinition/injection-point` with `{x, y, view}` sub-extensions
  (view ∈ front/left/right/back), normalized to a canonical face diagram. **Rationale:** FHIR has
  no element for 2D diagram coordinates; SNOMED body sites stay the semantic truth, the extension
  is presentation geometry only. Exact shape finalizes with the staff-app canvas design (deferred).
- **Clinical photos**: `Media` (`encounter` link; content via `Attachment.url` → `Binary`,
  presigned on read). Capture/use gated on the photo `Consent`; review Medplum's Binary security
  context for photo access. Note: `Media` was removed in FHIR R5 (folded into DocumentReference) —
  this is an R4-lifetime choice, fine on Medplum (R4), recorded here deliberately.
  Retention/size policy: **deferred until photos ship** (open item).

### Treatment series (packages of N sessions)

- **Clinical progress → FHIR `CarePlan`** per series (`status` + `intent` required), one
  `activity` per session. R4 legality (corrected at review): booked-not-yet-done sessions →
  `activity.reference` → `Appointment`; **performed sessions → `activity.outcomeReference` →
  `Procedure`** (Procedure is not a legal `activity.reference` target); back-link
  `Procedure.basedOn` → CarePlan. "3 of 6 done" = activities with an outcomeReference.
- **Commercial state → experience DB** `package` table (patient id, care-plan id, sessions
  purchased/remaining, Stripe payment refs). The split: what happened to the body is FHIR; what
  was bought and what's left is experience data. Reconciled by patient id + care-plan id.

### Consents

- `Consent` per consent type (treatment, photo/media use, financial policy). Required fields:
  `status`, `scope`, `category`, and a `policy`/`policyRule` (invariant ppc-1).
  `sourceReference` → **`DocumentReference`** (the signed artifact; its
  `content.attachment.url` points at the `Binary` — `Binary` is not a legal sourceReference
  target). `provision.period` bounds validity — **nothing auto-expires a Consent**: the BFF/Bot
  must evaluate the period, not just `status: active`. Intake/medical-history forms: versioned
  `Questionnaire` definitions + `QuestionnaireResponse` per submission.
- Later (not v1): a Bot that flags clinical capture lacking an active treatment Consent.

### Memberships & loyalty

- **Entirely experience data + Stripe.** `membership` table (patient id, tier, status,
  `stripe_customer_id`, `stripe_subscription_id`); loyalty ledger likewise. Nothing in FHIR at v1
  (no clinical eligibility semantics yet).
- **Stripe hard constraint** (CLAUDE.md), decided at review: Stripe customers get **email only**
  (receipts) and generic product names ("Aureva Membership") — no real name unless
  disputes/chargebacks force it, and never patient/diagnosis/service context in
  metadata/descriptors/customer fields.

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
admin UI, and goes through security-reviewer. AuditEvent emission is a deployment setting that
must be verified per environment — see `docs/AUTH.md` (attribution section).

### Review log

- **2026-07-02 — booking amendment (A2, approved in principle via docs/V0_PROPOSAL.md §5;
  landed with S3)**, all verified against the Medplum **v5.1.9 server source** (find.ts,
  book.ts, scheduling-parameters.ts): (i) at our pin the scheduling ops are **`$find` + `$book`
  only** — `$hold`/`$confirm`/`$cancel` do not exist (adopting them later is a Medplum-pin
  question); `$find` is GET-only, instance-level per Schedule, and REQUIRES
  `service-type-reference` with a ≤31-day window. (ii) Every bookable service is therefore also
  a **`HealthcareService`** carrying the `https://medplum.com/fhir/StructureDefinition/SchedulingParameters`
  extension (`duration` required; buffers/alignment optional), reconciled with the
  experience-DB catalog row by our CodeSystem `code` + stored `healthcareServiceId`. (iii)
  Precision on the earlier one-actor note: the IANA **timezone extension
  (`http://hl7.org/fhir/StructureDefinition/timezone`, valueCode) lives on the Schedule's single
  ACTOR resource**, not the Schedule; Schedule-level SchedulingParameters additionally REQUIRE
  `service` (HealthcareService reference) and `availability` sub-extensions. (iv) `$book` takes
  a Parameters body with 1+ proposed free Slots (+ optional `patient-reference`), runs in a
  serializable transaction, returns 201 with the booked Appointment + busy Slot, and 409s a
  taken window; the booked duration must exactly equal the SchedulingParameters duration.
  Builders + typed wrappers live in `@medibun/medplum-backend` (`scheduling.ts`) with
  shape-pinning unit tests; the demo seed (`pnpm demo:seed`) creates org/location/practitioners/
  services/schedules and self-checks `$find` returns slots.
- **2026-06-11 — accepted** (Alec) after adversarial validation against hl7.org/fhir/R4 and
  medplum.com docs. Corrections applied: CarePlan activity/outcomeReference split; Consent
  sourceReference → DocumentReference only + required fields; Medplum `$book` scheduling +
  one-actor Schedules; Medication per product+lot; `meta.accounts`/`$set-accounts` tenancy
  mechanics. Deferred items: injection-point extension final shape (with staff-app canvas), photo
  retention policy (before photos ship), minors/guardianship (Phase 2+).

## Migration (Handal off 4D) — later

Phase 3. One-time cut-over from the 4D EMR; verify 4D export capability early (Phase 0 paperwork).
History migration + retirement of 4D. Out of scope until then.
