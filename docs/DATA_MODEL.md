# Data model

Seeded from `PROJECT_BRIEF.md`. This is a **stub** — the real modeling is the first work item after
the environment is up, and per the brief we **ask before modeling**. Nothing below is implemented.

## Two stores, one reconciliation key

| | **Medplum (clinical)** | **Our DB (experience)** |
|---|---|---|
| Owns | FHIR clinical record — the source of truth | Non-clinical experience data |
| Examples | Patient, Practitioner, Encounter, Observation, consents, charting, prescriptions | Memberships, loyalty/rewards, app preferences, push tokens, growth-journey state |
| Accessed via | The BFF only (server-side Medplum SDK) | The BFF (its own database) |
| Reconciled by | **patient ID** ←──────────────────────────→ **patient ID** | |

Rule: clinical data never moves into the experience DB and vice versa; they reference each other by
ID. PHI lives in Medplum (and transiently in the BFF), never in client storage, logs, analytics, or
Stripe. See `.claude/rules/{security,fhir}.md`.

## Aureva FHIR model — TO BE DESIGNED (ask first)

The brief's first real work item is the **Aureva** (medspa) FHIR data model. Do not model these
without explicit go-ahead; when greenlit, design each here with the resources/extensions chosen and
the rationale:

- **Injection maps** — anatomical injection sites/doses (product, units, location). Likely
  Observation/Procedure + extensions or a body-site mapping; TBD.
- **Treatment series** — multi-session treatment plans/packages and progress. Likely CarePlan /
  related Procedures; TBD.
- **Consents** — treatment/photo/financial consents. FHIR Consent; TBD.
- **Memberships** — note the split: clinical eligibility vs. the membership *product/billing* (the
  latter is experience data + Stripe, not FHIR). TBD where the line sits.

Each model entry should record: chosen FHIR resource(s), any custom extension (with URL + why
standard resources don't suffice), the AccessPolicy implications, and audit expectations.

## Multi-tenant (Handal + Aureva) — decision pending

Single core, two practices. Two valid Medplum approaches (architecture sign-off required before
choosing):

- **Parameterized AccessPolicies** on one Project (bind to organization/compartment via
  ProjectMembership) — more operable for shared staff and cross-tenant reporting.
- **Separate Projects** per tenant — strongest data isolation.

Default to least-privilege/default-deny whichever is chosen; verify AuditEvent capture on every PHI
path. See `.claude/rules/fhir.md`.

## Migration (Handal off 4D) — later

Phase 3. One-time cut-over from the 4D EMR; verify 4D export capability early (Phase 0 paperwork).
History migration + retirement of 4D. Out of scope until then.
