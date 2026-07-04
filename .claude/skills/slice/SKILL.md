---
name: slice
description: The start-to-done ritual for building a v0 slice (S-numbered work from docs/V0_PROPOSAL.md). Use when starting a new slice, resuming one, or checking whether a slice is actually done.
---

# Slice ritual

## Start

1. Read `docs/V0_PROPOSAL.md` (§9 status log tells you where the project actually is), plus
   `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, and any spec the slice names
   (BOOKING_DESIGN.md, AUTH.md, PATIENT_SURFACE.md). The docs are the project's memory —
   trust them over assumptions.
2. Branch off latest `main`. One slice, one branch, one PR.
3. Before non-trivial building, state the plan with a verify step per item, and surface any
   approval-gated territory NOW (auth/authz/AccessPolicy, schema/FHIR migrations, PHI-touching
   deps, destructive ops — CLAUDE.md list): those need Alec's explicit yes, never
   auto-execute.

## Build loop

- Test-first (`.claude/rules/testing.md`): failing test → satisfy it. The per-edit hook runs
  typecheck+lint, so keep test+impl edits close together.
- Surgical diffs; match the package's import style (explicit `.js` for web/packages,
  extensionless in the Expo app).
- UI work: finish with the `visual-check` skill — screenshots at desktop AND phone width,
  compared against the spec.

## Done (all of it, before calling it shipped)

1. `pnpm format` then the gate: `pnpm format:check && pnpm typecheck && pnpm lint && pnpm test`
   (CI runs the same — format:check failures are CI failures).
2. Definition of done from CLAUDE.md: new behavior has tests; no secrets/PHI in diff, logs, or
   fixtures; `security-reviewer` subagent on any PHI/auth/AccessPolicy change; affected docs
   updated in the same change (new/changed BFF endpoints → docs/API.md; and update
   tools/visual-check/stub-bff.mjs to match).
3. Update the slice's row in `docs/V0_PROPOSAL.md` §9 — status, what shipped, what's parked,
   what needs live verification on a real stack. A fresh session must be able to resume from
   the repo alone.
4. Commit with a descriptive message; push with `git push -u origin <branch>`.
