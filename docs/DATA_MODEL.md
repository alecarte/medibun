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

### Recovery staging (R1, amended R2a)

The ingestion half of the recovery engine, landed as experience-DB tables (full design:
`RECOVERY_DESIGN.md` §2–3). Tables holding **administrative and financial fields only** —
no clinical column exists, and the engine never asks for one. That guarantee is **structural for
every typed column and conditional for the `*_raw` ones**: `status_raw`, `service_category_raw`,
`outcome_raw`, `channel_raw`, `provider_raw`, `booked_raw`/`completed_raw` and the inquiry `name`
stage the source's own text verbatim, so the two-store rule holds only as long as those columns
really are coded labels in 4D. **R0's signal is favorable** — the procedure/service/product menus
are coded and the Category taxonomy carries short codes — but R0 closed without recording an
explicit verdict, so the allow-list question stays open (carried to the R2a walkthrough): if any
of these is a free-text field an operator can type a reason into, the adapter maps it through an
**allow-list of known labels** (unrecognized → rejected row) instead of staging it verbatim — a
change to `adapter-4d.ts`'s column map, not to the schema. Two source columns are meanwhile
excluded **by construction** rather than mapped:
the appointment export's `Allergy` (clinical) and `Description` (operator free text that can carry
a visit reason), plus the revenue export's line-item description for the same reason. The adapter
drops them on read; no column exists to hold them.

| Table                 | Holds                                                                                                                                         | PHI status                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `imports`             | One row per (file, entity) import run: source system, basename, sha256, row/staged/rejected counts, rejects path                              | **No PHI** — counts and identifiers only                        |
| `staged_patients`     | Source patient id, name, date of birth, phone + phone type, email, lifetime spend, the (unused) Medplum link                                  | **PHI** — administrative identity + contact + spend only        |
| `staged_appointments` | Source/derived appointment identity, optional patient source id, name+DOB+phone join keys, start instant, raw status/category/provider labels | **PHI-adjacent** — times, statuses, category labels             |
| `staged_inquiries`    | Source inquiry id, occurrence instant, raw channel/outcome, optional name + phone                                                             | **PHI** — contact only (an inquirer may never become a patient) |
| `staged_consults`     | Quote number, patient **name**, consult date, raw category/outcome/provider/booked/completed labels, quoted amount                            | **PHI-adjacent** — dates, category labels, quoted dollars       |
| `staged_transactions` | **PROPOSED (R2a):** derived row identity, optional patient source id, transaction date, raw category, amount (cents)                          | **PHI-adjacent** — dates, category labels, money                |
| `service_categories`  | Category code + display, expected-return interval (hand-set), typical ticket + the basis it was derived from                                  | **No PHI** — financial/cadence config only                      |

- **R0 corrections (R2a migration `0004`).** The real 4D exports differ from R1's provisional
  model, and the schema follows the exports: the **appointment** export carries no patient id and
  no status column (`patient_source_identity` and `status_raw` are nullable; `patient_name`, `dob`,
  `phone` are the roster join keys), and the **consult** source — Conversion By Provider — carries
  a patient _name_ only, a date rather than an instant, the quote number as its row identity, and
  the quoted dollars (`consult_at` → `consult_date`; `patient_name` NOT NULL;
  `patient_source_identity` nullable and null at import — the name-join runs at query time and an
  ambiguous match is flagged for a human, never guessed). Because the migration adds NOT NULL
  columns to `staged_consults`, it applies to an **empty** staging table — true everywhere today
  (no import has run outside tests); a local database that already staged consults is truncated
  before applying, never migrated around.
- **Derived source identities.** Two exports carry no row id of their own (appointments, revenue).
  For those the **adapter derives** `source_identity` — sha256 of the row's normalized identifying
  fields plus an occurrence suffix that separates true duplicates — so the idempotency rule below
  holds unchanged. Derivation is the adapter's business; the column's contract does not change.
- **`staged_transactions` is proposed, not settled.** Dormancy computes primarily from the last
  **paid** visit per patient per category (R0), which makes revenue rows a queryable input rather
  than a one-off average — superseding the earlier "compute averages locally, no new table" note.
  The table lands with this migration for Alec's walkthrough; declining it means dropping the table
  and computing category averages into `service_categories` instead, at the cost of the dormancy
  signal.

- **Reconciliation keys.** `(source_system, source_identity)` identifies a staged row — a unique
  index on the pair, and the idempotency key below. `staged_appointments` / `staged_consults` /
  `staged_inquiries` carry `patient_source_identity` and join staging-side **with no foreign
  key**: a source export routinely names patients missing from the roster it shipped, and
  segmentation treats those as degraded rows rather than losing them at import. Promotion to a
  Medplum `Patient` reconciles by `medplum_patient_id`, which stays **null through R1** —
  identity promotion and its manual-merge queue land before R5 enrollment.
- **Idempotency rule.** Re-import upserts by `(source_system, source_identity)`: a fresh export
  supersedes the last one, reconciling changed values onto the existing row (including clearing
  a value the newer export dropped) and re-stamping `import_id` / `updated_at`. Rows are never
  duplicated and never deleted by an import. **Every run appends an `imports` row even when
  nothing changed** — that ledger, with its file hash and counts, is the reconciliation evidence
  behind an attribution dispute.
- **Times.** Source exports carry practice-local wall times with no offset, so the adapter is
  told the practice's zone explicitly and converts through the BFF's existing timezone helper.
  An unparseable time is a **rejected row**, never a silent UTC reading — a bad conversion moves
  appointments across days and quietly corrupts segmentation. Where an export carries a **date and
  no time** (consults, revenue rows), the column is a `date` — inventing a midnight instant would
  claim a precision the source does not have.
- **Rejects.** Row-level validation failures come back to the caller as `{ line, reason, raw }`.
  The `reason` names the **column** at fault and never the value; the `raw` line reaches only the
  local `<file>.rejects.csv` the CLI writes (owner-readable). No raw source content is logged or
  stored in any column. `imports.rejects_uri` records that file's **basename** (a directory a
  human chose can itself name a patient, so nothing path-shaped is stored — same rule as
  `file_name`); it is null for a clean run, and the CLI deletes any stale rejects file before
  each run so a "clean" ledger row never sits beside the previous run's raw rows.
- **Provisional columns.** `staged_consults` is now modeled from the real export (above);
  `staged_inquiries` stays modeled from `RECOVERY_DESIGN.md` §2's shopping list and **unused** —
  R0 found 4D tracks no inquiries, so that pool is parked for engagement zero. The 4D column
  **headers** the adapter maps stay provisional in R2a: the report-layout normalization pre-pass
  and the derived identities land in the next PR, not this migration.
- **Attribution debt (before any HTTP surface or cloud promotion).** An `imports` row records
  _what_ ran, not _who_ ran it — acceptable while ingestion is one operator on one local machine
  (§7), but "every PHI write attributable to an authenticated principal" needs an actor column
  the moment a second person, an endpoint, or a hosted stack can trigger an import. Tracked in
  the §7 cut-over checklist.

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

- **2026-08-14 — R0's schema corrections + the R2 config table proposed (R2a; the B2 gate's
  second migration) — PENDING Alec's schema walkthrough and merge.** Migration `0004` ships
  five things, none of them approved until Alec has walked the schema and merged: **(1)**
  `service_categories` — R2's financial/cadence config (code, display, hand-set
  expected-return interval, typical ticket + the `ticket_basis` methodology marker), no PHI;
  **(2)** `staged_transactions` — **PROPOSED, the walkthrough's real decision**: R0 found
  dormancy computes from the last _paid_ visit per patient per category, so revenue rows must be
  queryable rather than averaged once and discarded (this supersedes the earlier "compute
  averages locally instead of a new table" note); deliberately **no line-item description
  column** — operator-typed descriptions can carry visit-reason-adjacent text, and category +
  amount + date is all the math needs; **(3)** the `staged_appointments` corrections (nullable
  patient id and status, name/DOB/phone roster join keys) and **(4)** the `staged_consults`
  corrections (`consult_at` → `consult_date`, NOT NULL `patient_name`, nullable patient id,
  provider/quote/booked/completed) — both are R0's "corrections are a follow-up migration at the
  same gate" arriving; **(5)** `staged_patients.spend_cents` (dormant-pool value weighting) and
  `phone_type` (R5 needs mobile-vs-home; **strikeable** at the walkthrough if staging it four
  slices early is unwelcome). Address columns stay unstaged. Carried to the walkthrough: the
  `*_raw` allow-list question (R0 signal favorable, no explicit verdict recorded), import-actor
  attribution (RECOVERY_DESIGN §7 checklist), and the NOT NULL adds' empty-table assumption
  above. The adapter's 4D **headers** are still provisional — the normalization pre-pass and the
  derived row identities are the next PR.
- **2026-08-13 — recovery staging tables landed (R1 merged, PR #21, Alec).** The entry below
  is resolved: Alec walked the schema and merged, which per the B2 gate's rule approves
  migration `0003` (the five staging tables). Still open from that entry: the `*_raw`
  free-text verdict (R0's field-mapping assessment) and import-actor attribution (the
  RECOVERY_DESIGN §7 cut-over checklist).
- **2026-08-12 — recovery staging tables proposed for landing (R1; the B2 gate's first
  migration) — PENDING Alec's schema walkthrough and merge.** The five staging tables above
  (`imports`, `staged_patients`, `staged_appointments`, `staged_inquiries`, `staged_consults`)
  ship as migration `0003` on the R1 PR, which **is** the B2/A6 gate: nothing here is approved
  until Alec has walked the schema and merged. Scope held to the V1 §5 R1 list:
  `service_categories` (R2) and the attribution ledger (R5) stay unbuilt, and
  `medplum_patient_id` lands as an unused column — **no Medplum write happens in R1**, identity
  promotion is its own slice. Two open items carried to that walkthrough: the `*_raw`
  free-text question above (R0) and the missing import-actor attribution (§7 checklist).
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
