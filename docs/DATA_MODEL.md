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

### Internal events (S5c — staff meetings, misc time blocks, time off as titled blocks)

- An internal event is a **patient-less `Appointment`** (`status: booked`) carrying a coding
  from our CodeSystem `https://medibun.com/fhir/CodeSystem/internal-events` in
  `appointmentType` (`meeting` | `block`), `description` as the display title,
  and one `participant` per affected Practitioner — **plus one `busy-unavailable` Slot per
  Schedule those practitioners own**, referenced from `Appointment.slot[]`. The busy Slots
  are what make `$find` refuse the window to patient booking (the same Appointment+Slot
  pairing `$book` creates); the Appointment is the visible, deletable event. A practitioner
  has one Schedule per service, so a block covers all of them.
- **Time off is not a code** (amendment, Alec 2026-07-06 — replaced the original `day-off`
  code before any stack carried one): PTO/time-away is a **titled block**, all-day or
  partial (half-days). "All day" has no flag in FHIR either — it's simply a window
  spanning the full practice-local day (00:00 → next 00:00), detected on read from the
  wall times, which stays true across 23/25-hour DST days.
- **Titles are non-PHI by rule**: no patient names/details, ever — they render unmasked
  under the staff privacy glance mask and are stated as such at the create UI.
- **Split principals** (decided 2026-07-06 + security-review remediation, same change):
  the READS run **as the caller** — the schedules read on create and the delete-probe
  Appointment read use the staff user's own token, so their org-scoped AccessPolicy
  decides what they can touch and those reads' AuditEvents name the real staff user.
  Only the Slot/Appointment WRITES run under the BFF service client: staff Slot access
  is deliberately readonly, and widening it was rejected in favor of S4's "via BFF"
  pattern (write AuditEvents name the service client — the same accepted tradeoff as
  booking). Create is compensating (slot create failures roll back, stranded slot ids
  logged); delete removes slots first so a partial failure stays visible and retryable.
- Race note (v0-accepted): creating the busy Slots doesn't run inside `$book`'s
  serializable transaction, so a patient booking in the same instant as a block creation
  can interleave — the overlap is visible on the calendar and resolved by staff
  (reschedule lands with S5.5). Existing bookings never block time off on purpose:
  marking the day off IS how staff discover who must be called.
- Recurring events / weekly templates stay post-v0 (COMPETITIVE_NOTES §1).

### Cancellation + move-up list (S5.7)

- **Cancel is not an operation at our pin** (`$cancel` doesn't exist at v5.1.9, per the
  A2 correction): a staff cancel is an `Appointment.status → cancelled` patch
  (test-and-set on status + versionId) **plus deleting the appointment's protector
  Slot(s)** — removing the busy Slot is exactly what makes `$find` offer the window
  again. Order is a safety property: status first, slots after (a partial failure
  strands a busy Slot — availability loss, ids logged — never a bookable window with a
  live appointment). Restore (the ~10s undo) runs the mirror image: re-mint the
  protector, re-check the window with the claim visible (the S5.5 pattern), then patch
  back to `booked` — an occupied window 409s honestly.
- **Cancellation reason is coded, never free text** (no PHI by construction): our
  CodeSystem `https://medibun.com/fhir/CodeSystem/cancellation-reason`
  (`patient | practice | no-longer-needed`) written to `Appointment.cancelationReason`
  (example binding — custom CodeSystem is conformant, same argument as services /
  internal-events). Restore removes it.
- **Split principals**, same as S5c/S5.5: reads + the Appointment patch run AS THE
  CALLER (org-scoped policy, audit attribution); only the Slot writes ride the BFF
  service client (staff Slot access stays readonly).
- **The move-up list is EXPERIENCE data** (`move_up_requests`, migration approved at
  the S5.7 interview): **ids only** — patient id, held-appointment id, service code,
  optional practitioner preference — plus a ≤120-char note that is **non-PHI by rule**
  (availability quirks; same rule + create-UI microcopy as internal-event titles) and
  `status: waiting | fulfilled | removed` with timestamps. Names/phones/times resolve
  live from FHIR as the caller on every read; nothing PHI-shaped is stored. One
  _waiting_ entry per appointment (partial unique index). Fulfilling = rescheduling
  the held appointment earlier via S5.5, then marking the entry.
- **Phase-2 growth-engine seam (seam only, decided at the interview):** auto-matching
  is a Bot on a `Appointment?status=cancelled` Subscription working `waiting` rows;
  the status/resolvedAt columns and the ordinary-FHIR-write cancel path are that seam.
  Nothing auto-matches in v0 — the desk works the list manually (phone; no SMS/push
  vendor yet). The seam should also add a `resolvedBy` column (security-review LOW,
  2026-07-09): today's desk-only resolve isn't principal-attributed in the row, and
  the Bot will need to distinguish machine from desk resolutions.
- **Pre-second-tenant follow-up** (security-review LOW, 2026-07-09 — joins the
  standing list under the AccessPolicy table): the move-up list/count queries are not
  tenant-scoped. Rows are ids-only and caller-side FHIR resolution degrades cross-org
  PHI to "Unknown", but an org column or org-scoped filter MUST land before Handal
  joins the project.

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

**Operational directory reads (added with S5, see review log):** both staff roles additionally
get **read-only** Schedule, Slot, HealthcareService, Practitioner, and Location — non-patient
operational/directory data the day sheet and scheduling UI require. These entries are currently
**unscoped** (no org criteria): non-patient-compartment resources don't inherit `meta.accounts`,
so org-scoping them needs explicit tagging — a recorded follow-up that MUST land before the
second tenant (Handal) joins the project. Same deadline for the check-in Bot's project-wide
Encounter write (`bot-check-in-v1`).

Default-deny everything else. Policies are **templates parameterized by Organization** (ADR-0003);
no hand-rolled per-user policies. Every policy lands via reviewed code (Medplum CLI), never the
admin UI, and goes through security-reviewer. AuditEvent emission is a deployment setting that
must be verified per environment — see `docs/AUTH.md` (attribution section).

### Review log

- **2026-08-11 — v1 re-cut: recovery staging + attribution ledger (B2, approved in principle
  — pending its migration PR).** The recovery engine adds experience-DB **staging tables**
  (`imports`, `staged_patients`, `staged_appointments`, `staged_inquiries`, `staged_consults`,
  `service_categories`) and the **attribution ledger** (`campaigns`, `enrollments`, `touches`,
  `recoveries`) — restricted by rule to **administrative/financial** fields (identity, contact,
  appointment times/statuses/service category, inquiry outcomes, ticket values); clinical
  content never enters the experience DB. PHI-bearing outbound message content lives
  clinical-side as org-tagged Medplum **`Communication`** resources (the ledger keeps ids);
  new CodeSystems `…/recovery-pools` and `…/outreach-templates`. Full design:
  `RECOVERY_DESIGN.md` §3. The migrations stay approval-gated (A6/B2 discipline) and land
  staged at their slices — R1 staging, R2 `service_categories`, R5 ledger — Alec walks each
  schema at its landing PR (clarified 2026-08-12; this entry records the in-principle
  decision, not the landings).
- **2026-07-09 — cancellation + move-up list (S5.7) added** (design
  interview-approved by Alec in-session: detail-card cancel with a **coded reason**
  over free text; the approved `move_up_requests` migration — the A6-family gate;
  staff-only list entry in v0; manual desk workflow with Bot auto-match as a
  Phase-2 seam). See the "Cancellation + move-up list" section above; endpoints in
  `docs/API.md`. No AccessPolicy change: cancel/restore reuse the staff Appointment
  write + service-client Slot writes already granted.
- **2026-07-06 — internal events (S5c) added** (design interview-approved by Alec
  in-session: Appointment + busy Slots over slots-only or availability edits; service-client
  writes over staff policy widening; three types with delete/undo). See the "Internal
  events" section above; endpoints in `docs/API.md`. Org-compartment visibility of the
  service-client-created event Appointments to staff readers rides the same
  `meta.accounts` propagation question as `$book` writes — added to the same §9
  live-verify item, same `$set-accounts` fallback. **Security-review remediation (same
  change):** the events path now splits principals — the schedules read (create) and the
  delete-probe Appointment read run AS THE CALLER (their org-scoped Appointment policy
  hides other tenants' events, which then 404 like unknown ids, and the probe read's
  AuditEvent names the real staff user); only the Slot/Appointment writes stay on the
  service client. Create's org affinity rides the operational-read scoping already
  tracked pre-second-tenant (above), through the same caller-read choke point.
- **2026-07-04 — S5 staff policies landed (A3 partial; G1/G2 approved by Alec in-session).**
  First implementations of the table above: `staff-front-desk-v1` and `staff-clinician-v1`
  (org-parameterized via `ProjectMembership.access[]` + `organization` parameter), plus
  `bot-check-in-v1` for the A7 check-in Bot. Deviations, all NARROWER than the table except the
  operational-read note above: front-desk Consent/QR held read-only-as-table; Schedule/Slot held
  **read-only** for both roles (no schedule-editing surface exists yet); clinician **Media
  deferred to S7** (lands with photos + consent gating). Org compartment matching runs through
  `Patient.meta.accounts` (tagged at seed; patient-compartment writes — Appointments, Encounters
  — inherit it per Medplum account propagation; live-verify item in V0_PROPOSAL §9, with the
  approved-in-principle `$set-accounts` service-client grant as the fallback). Security-reviewer
  PASS 2026-07-04; pre-second-tenant follow-ups recorded in the note above.
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
- **2026-07-02 — booking live-verification fix** (against real Medplum 5.1.9 via `demo:seed`):
  `$find` has a _second_ gate beyond SchedulingParameters — `find.ts:120` requires a top-level
  **`Schedule.serviceType[]`** concept carrying Medplum's `https://medplum.com/fhir/service-type-reference`
  extension whose `valueReference` equals the requested HealthcareService (verified in v5.1.9
  `util/servicetype.ts`). Without it the live server returns "Schedule is not scheduleable for
  requested service type" even when `SchedulingParameters.service` matches. `buildSchedule` now
  emits it; the unit test regression-pins it. (Mocked tests can't reach this gate — this is why
  the live seed self-check exists.)
- **2026-06-11 — accepted** (Alec) after adversarial validation against hl7.org/fhir/R4 and
  medplum.com docs. Corrections applied: CarePlan activity/outcomeReference split; Consent
  sourceReference → DocumentReference only + required fields; Medplum `$book` scheduling +
  one-actor Schedules; Medication per product+lot; `meta.accounts`/`$set-accounts` tenancy
  mechanics. Deferred items: injection-point extension final shape (with staff-app canvas), photo
  retention policy (before photos ship), minors/guardianship (Phase 2+).

## Migration (Handal off 4D) — later

Phase 3. One-time cut-over from the 4D EMR; verify 4D export capability early (Phase 0 paperwork).
History migration + retirement of 4D. Out of scope until then.
