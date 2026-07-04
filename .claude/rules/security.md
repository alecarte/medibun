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

## Hooks that enforce this

The pre-edit hook blocks common secret patterns (no hardcoded keys/tokens/passwords),
blocks SSN/MRN/DOB-shaped values, and asks for confirmation on edits to sensitive files.

## Vendors

Approved in principle (BAA still required before prod PHI): Medplum Cloud, Vercel (Pro+HIPAA),
Sentry, PostHog. Stripe signs no BAA — the "Stripe never receives PHI" invariant (no
patient/diagnosis/service context in metadata, descriptors, or customer fields) lives in
CLAUDE.md's architecture invariants.

## Review

Any change touching PHI, auth, or AccessPolicy runs the `security-reviewer` subagent before
it's done (definition of done, CLAUDE.md).
