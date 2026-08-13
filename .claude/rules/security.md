# Security & HIPAA rules

Operational addenda to the **Security & HIPAA section of `CLAUDE.md`** — that section is
canonical (the PHI-leak surfaces, least-privilege AccessPolicy, audit-always-on, secrets, data
minimization/encryption, the human-approval gate, STOP-and-ask). Binding. This file adds only
the specifics CLAUDE.md doesn't spell out; don't restate it here.

## PHI-leak specifics

- The leak list explicitly includes **test fixtures** and all plaintext client storage
  (AsyncStorage / localStorage / cookies), and analytics/telemetry stay PHI-free **even with a
  BAA**.
- Log identifiers (resource IDs, correlation IDs), never PHI values.
- Sentry: `sendDefaultPii: false`, scrub request bodies/headers in `beforeSend`; Session Replay
  off or fully masked. PostHog: `autocapture: false`, sanitize in `before_send`, recording
  off/masked.
- Test/seed data is synthetic and non-PHI — no real SSN/MRN/DOB/patient identifiers.

## Real-PHI runbook (R-track, binding)

Until every touched cloud service has a signed BAA: real practice exports and real staging
live **only** on practice-controlled hardware; raw exports are never committed, uploaded, or
pasted into cloud tools; the import CLI runs fully local; fixtures/seeds stay synthetic (rule
above). Cloud promotion of real data is a single explicit cut-over recorded in
`RECOVERY_DESIGN.md`'s review log. Full runbook: `RECOVERY_DESIGN.md` §7.

## Hooks that enforce this

The pre-edit hook blocks common secret patterns (no hardcoded keys/tokens/passwords),
blocks SSN/MRN/DOB-shaped values, and asks for confirmation on edits to sensitive files.

## Vendors

Approved in principle (BAA still required before prod PHI): Medplum Cloud, Vercel (Pro+HIPAA),
Sentry, PostHog, Neon (Scale plan — ADR-0002). A comms vendor (SMS/email) joins via ADR-0005
(gate B4) — BAA signed before any real send. Full clock list: `V1_PROPOSAL.md` §7. Stripe signs no BAA — the "Stripe never receives PHI" invariant (no
patient/diagnosis/service context in metadata, descriptors, or customer fields) lives in
CLAUDE.md's architecture invariants.

## Review

Any change touching PHI, auth, or AccessPolicy runs the `security-reviewer` subagent before
it's done (definition of done, CLAUDE.md).
