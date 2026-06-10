# ADR-0002: Experience database (vendor + ORM)

- **Status:** Accepted (Alec, 2026-06-10 — including the human-approval gate for Neon as a new
  PHI-touching service per CLAUDE.md; BAA still required before production data)
- **Date:** 2026-06-10
- **Sprint:** 01, goal 2 (see `docs/sprints/2026-06-10-sprint-01.md`)

## Context

The thick BFF owns its own database for **experience data**: memberships, loyalty, preferences,
push tokens, growth state (`docs/ARCHITECTURE.md`). Medplum remains the clinical source of
truth; the two reconcile by patient ID.

**Compliance framing:** experience rows are keyed by patient ID, and "is a patient of this
practice" is itself PHI. The experience DB is therefore a **PHI-touching service**: the vendor
must sign a BAA before production data, encryption in transit/at rest, least-privilege access.
Local/synthetic dev carries no such requirement.

## Options considered

### A. Neon — serverless Postgres (recommended)

- (+) **HIPAA BAA self-serve on the Scale plan**; HIPAA projects run on isolated infra with
  AES-256 at rest and audit logging. Currently no surcharge (a 15% surcharge is announced for
  the future — acceptable, flagged here).
- (+) Serverless driver fits Vercel functions (no connection-pool management); scale-to-zero
  keeps pre-launch cost near nil; branch-per-PR is genuinely useful for schema work.
- (+) Just Postgres — no platform features that overlap with the BFF's job. (Vercel's own
  "Postgres" marketplace offering is Neon under the hood, so this is also the
  path-of-least-resistance integration.)
- (−) Newer vendor than AWS; mitigations: it's plain Postgres — `pg_dump` works, exit is cheap.

### B. Supabase

- (+) Mature Postgres platform; BAA available.
- (−) BAA requires **Team plan ($599/mo) + a HIPAA add-on with unlisted pricing** — the most
  expensive path by far.
- (−) Its value is the bundled platform (auth, storage, realtime, client SDKs) — which our
  architecture deliberately assigns to the BFF and Medplum. We'd pay for overlap and create
  boundary-erosion temptation.

### C. AWS RDS Postgres

- (+) The incumbent compliance answer; BAA via AWS Artifact; maximal control.
- (−) VPC/networking/patching ops burden now, awkward pairing with Vercel functions (needs
  RDS Proxy etc.), and slowest to stand up. The right escape valve later if we ever consolidate
  onto AWS, not the right first DB for a two-person-scale platform.

## ORM: Drizzle (over Prisma)

- TypeScript-first, SQL-shaped, no codegen step or query engine; works with Neon's serverless
  driver; `drizzle-kit` emits plain SQL migrations we can read and audit (which matters when
  the schema holds PHI-adjacent data).
- Prisma is also fine in 2026 (TS-native engine now), but it's a heavier abstraction than this
  schema needs — the experience model is a handful of relational tables.

## Decision (proposed)

**Option A — Neon (Scale plan when HIPAA is needed; free/launch tier for dev) + Drizzle ORM.**
Schema lives in `apps/api` (or `packages/db` if it grows); migrations via `drizzle-kit` checked
into the repo and applied through CI/CD, never by hand against prod.

## Consequences

- New vendor approval: **accepting this ADR approves Neon in principle**; executing the Neon
  BAA before production data joins the existing paperwork track (with Medplum + Vercel BAAs).
- Dev: a Neon free-tier project (synthetic data only) or local Postgres via docker-compose —
  no BAA needed until real PHI.
- `apps/api` gains `drizzle-orm` + Neon driver as dependencies when the first experience table
  lands (membership/preferences in the vertical-slice follow-up, not this sprint's goal 4).
