# Docs

The documentation strategy, in one paragraph: **markdown in this repo is the single source of
truth**, versioned with the code it describes and updated in the same PR (the definition of done
in `CLAUDE.md` includes "affected docs updated" — the cheapest possible upkeep, no extra tooling
or tokens). The **eventual presentation layer is [Fumadocs](https://fumadocs.dev)** — it's
Next-based, so it fits the locked stack and consumes these same files as MDX; adopting it is a
later slice (an `apps/docs` site), not a rewrite. Until then, GitHub's renderer is the reader.
Write docs so that migration is mechanical: plain GitHub-flavored markdown, relative links, one
`#` title per file, no HTML that MDX would choke on.

## Map

| File                                           | What it is                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md)           | System shape: BFF anti-corruption boundary, two sources of truth, boundary discipline.                         |
| [`DATA_MODEL.md`](DATA_MODEL.md)               | FHIR + experience-DB modeling decisions, access table, custom extensions.                                      |
| [`API.md`](API.md)                             | The BFF's HTTP contract — every endpoint, auth model, and error code.                                          |
| [`AUTH.md`](AUTH.md)                           | Auth design: brokered Medplum login, sessions, cookies vs bearer, CSRF/origin guard.                           |
| [`DESIGN.md`](DESIGN.md)                       | Design tenets, the two registers (premium patient / quiet staff), token architecture.                          |
| [`BOOKING_DESIGN.md`](BOOKING_DESIGN.md)       | Research-backed booking + portal-shell spec (approved), incl. banned dark patterns.                            |
| [`PATIENT_SURFACE.md`](PATIENT_SURFACE.md)     | Distribution strategy: hosted portal → booking overlay → embedded components.                                  |
| [`SCHEDULE_DESIGN.md`](SCHEDULE_DESIGN.md)     | Staff Schedule spec (approved): layout/scroll, toolbar, views, keyboard + tooltips.                            |
| [`COMPETITIVE_NOTES.md`](COMPETITIVE_NOTES.md) | What the reference products (Resy, Lore, Othership, …) actually do.                                            |
| [`ROADMAP.md`](ROADMAP.md)                     | Phases (rewritten 2026-08-11): R revenue → L launch → G growth · H migration · P productize.                   |
| [`V0_PROPOSAL.md`](V0_PROPOSAL.md)             | The v0 cut + S1–S5.7 history and live-verify debt; unbuilt remainder superseded by V1.                         |
| [`V1_PROPOSAL.md`](V1_PROPOSAL.md)             | The v1 revenue re-cut (approved 2026-08-11): R-slices, B-gates, status log — the living project record.        |
| [`RECOVERY_DESIGN.md`](RECOVERY_DESIGN.md)     | Recovery-engine spec (approved): pools, ingestion adapters, sequencer, messaging standard, queue, attribution. |
| [`BAA_CHECKLIST.md`](BAA_CHECKLIST.md)         | The paperwork queue (BAAs + admin clocks) — Alec's; sessions build local/stub meanwhile.                       |
| [`adr/`](adr/)                                 | Architecture decision records (numbered, immutable once accepted).                                             |

Package-level docs live next to the code: each app and package has a short `README.md` saying
what it is, what it may depend on, and how to run it. Repo-wide setup lives in the
[root README](../README.md). The binding working rules live in [`CLAUDE.md`](../CLAUDE.md) and
[`.claude/rules/`](../.claude/rules/) — those override everything here.
