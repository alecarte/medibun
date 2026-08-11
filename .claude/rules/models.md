# Model protocol

Binding. Which Claude model runs which kind of work **in this repo** — the development harness.
Distinct from the model the _product_ calls at runtime, which is ADR-0004's decision at S6 (last
section below).

## The roster

| Role                       | Model                             | Runs                                                                                                                                                                     |
| -------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Orchestrator / lead**    | Claude Fable 5 `claude-fable-5`   | Plans and cuts the work, decomposes slices, spends agents, runs judge panels, synthesizes, holds the whole-system + compliance view, decides what goes to whom.          |
| **Execution — judgment**   | Claude Opus 5 `claude-opus-5`     | Anything with real judgment in it: PHI/auth/AccessPolicy, FHIR modeling, security review, adversarial verification, architecture, design surfaces, slice implementation. |
| **Execution — mechanical** | Claude Sonnet 5 `claude-sonnet-5` | Scoped work against a written spec: codemods, token plumbing, test scaffolding, doc edits, screenshot sweeps, wide read-only searches.                                   |

Three models, nothing else. Predecessor tiers (Opus 4.x, Sonnet 4.x) are not used for work in this
repo. Haiku 4.5 is current but is **not** in the roster — Sonnet 5 is the floor for a codebase this
regulated.

## Rules

- **Fable 5 plans; it does not do the bulk implementation.** Its job is the cut, the delegation, and
  the synthesis. Work it can finish in a handful of tool calls, it finishes itself — delegation has
  real overhead and re-briefing cost.
- **Opus 5 is the floor for anything PHI-touching.** PHI, auth, AccessPolicy, audit, and the FHIR
  data model never go to a cheaper tier, regardless of how small the diff looks. The
  `security-reviewer` subagent is pinned to Opus 5 for the same reason.
- **Escalate, never silently downgrade.** If a Sonnet 5 agent's task turns out to carry judgment,
  it hands back to Fable 5 to re-cut rather than guessing. A task is only Sonnet-shaped if the spec
  fully determines the answer.
- **Brief for a fresh context.** Subagents see none of the lead's conversation — every delegated
  task carries the paths, constraints, invariants, and report format it needs.

## Effort

- `xhigh` for coding and agentic execution on Opus 5 and Sonnet 5; `high` is the floor for anything
  intelligence-sensitive; `low` only for genuinely mechanical stages.
- On Fable 5 thinking is always on — don't configure it; control depth with effort.
- At `xhigh`/`max`, leave real output headroom (start at 64K `max_tokens`).

## Writing model IDs

- Use the exact IDs above. **Never append a date suffix** — `claude-opus-5`, not
  `claude-opus-5-<date>`.
- In `.claude/agents/*` frontmatter and Claude Code config, the aliases `fable` / `opus` / `sonnet`
  resolve to this roster; use the alias there and the exact ID anywhere a file or an API reads it.
- Model identifiers stay in config and chat — never in commit messages, PR bodies, or code comments.

## Product runtime — not this file's call

The model the **BFF AI module** calls on the product's behalf is ADR-0004's decision at S6, behind
approval gate A5 (`docs/V0_PROPOSAL.md` §5). Nothing in the product calls a model until that ADR is
approved and the Anthropic SDK dependency gate clears.

Recommended input to that ADR, **not yet approved**: `claude-opus-5` for ambient clinical capture
(S8) and the staff assistant tool-use loop (S11); `claude-sonnet-5` for the patient concierge's
grounded Q&A (S10). Provider and model stay swappable behind the choke-point module either way, and
the PHI gate stays shut until the Anthropic BAA is signed — see `security.md`.
