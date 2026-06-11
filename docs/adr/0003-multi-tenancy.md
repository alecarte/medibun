# ADR-0003: Multi-tenancy — one Medplum Project, parameterized AccessPolicies

- **Status:** Accepted (Alec, 2026-06-11)
- **Date:** 2026-06-11
- **Sprint:** 01, goal 5 prerequisite (flagged "confirm before choosing" in `.claude/rules/fhir.md`)

## Context

One clinical core serves two practices — Handal Plastic Surgery and Aureva Medspa — with shared
staff, cross-practice patients, and (Phase 4) more tenants later. Medplum offers two isolation
models: parameterized AccessPolicies within a single Project, or one Project per tenant.

## Decision

**A single Medplum Project for both practices.** Tenancy is expressed in data and policy:

- An `Organization` resource per practice (`org-handal`, `org-aureva`); `Location` per site.
- Every clinical resource is tagged with its owning practice (`meta.accounts` /
  `managingOrganization` where native) at write time — the BFF and Bots enforce this invariant.
- Access is granted through **AccessPolicy templates parameterized by Organization** and bound via
  `ProjectMembership` — least-privilege, default-deny. Shared staff get one membership per
  practice role; nobody gets project-wide access by default.
- `Patient` is core-wide (the "one record of truth" goal); see `DATA_MODEL.md` for the
  cross-practice visibility rules, which are policy decisions reviewed per resource type.

## Why not separate Projects

Hard isolation would break the single-record-of-truth thesis for patients seen at both practices,
double every Bot/Subscription/config deployment, and make Phase 4 productization a per-tenant ops
multiplication. The brief's mission ("one core for both practices") implies shared-project tenancy.

## Consequences

- Isolation is **policy-enforced, not physical** — which makes AccessPolicy review the critical
  control: any policy widening is human-approval-gated (CLAUDE.md), and the org-tagging invariant
  needs tests + a Bot-side guard before real PHI.
- Escape valve: a future tenant requiring hard isolation (or a regulator demanding it) can get its
  own Project; the BFF's anti-corruption boundary means apps never notice.
- Blast-radius caveat acknowledged: a mis-scoped policy can cross practices. Mitigations: policy
  templates (no hand-rolled per-user policies), security-reviewer on every policy change, audit
  always on.
