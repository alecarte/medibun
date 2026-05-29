# FHIR / Medplum rules

Conventions for the clinical core. Binding. Detailed resource modeling is deferred to
`/docs/DATA_MODEL.md` (ask before modeling).

## Anti-corruption boundary (non-negotiable)

- Product apps (`patient-mobile`, `portal`, `staff`) talk only to **our backend (the BFF)** via
  `@medibun/api-client`. They never import a Medplum SDK, hold a Medplum session, or call
  Medplum/any EMR directly.
- The **backend is the only Medplum SDK holder** (server-side `MedplumClient`). It translates our
  domain operations to/from FHIR.
- `@medibun/fhir-types` is **types-only** (may re-export `@medplum/fhirtypes`); importing it does
  not breach the boundary, but prefer domain DTOs at the app edge.

## Two sources of truth

- **Medplum** owns clinical data (the FHIR source of truth).
- **Our DB** owns experience data (memberships, loyalty, preferences, push tokens, growth state).
- Reconcile by patient ID. Never blur the two.

## AccessPolicy

- Least-privilege, default-deny. Grant access explicitly, per resource type and field.
- Assign policies to every user AND every client application.
- **Multi-tenant (Handal + Aureva):** prefer parameterized AccessPolicies (e.g. bound to an
  organization/compartment via ProjectMembership) on a single project; separate Projects only if
  hard data isolation is required. This is an architecture decision — confirm before choosing.
- Never widen a policy without human approval.

## Audit

- `AuditEvent` / `Provenance` on PHI access paths, always. (See `security.md`.)

## Bots & Subscriptions

- The growth engine and clinical event-logic run on FHIR **Subscriptions + Medplum Bots**
  (event-driven, on-platform, no polling).
- Bots are authored locally and deployed via the Medplum CLI (not the in-app button) for
  production/CI.
- Keep the boundary discipline: clinical + event logic → Bots/Subscriptions; experience data +
  third-party orchestration + client-shaping → BFF. Don't duplicate Medplum features in the BFF.

## Resource conventions

- Pin `@medplum/*` packages in lockstep (same minor). Deferred until the Medplum wiring step.
- Use FHIR-standard resources and documented extensions; record any custom extension in
  `/docs/DATA_MODEL.md` with rationale.
