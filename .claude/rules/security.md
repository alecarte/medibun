# Security & HIPAA rules

Operationalizes the Security & HIPAA section of `CLAUDE.md`. Binding.

## PHI must never leak into

Logs · error messages · analytics/telemetry (Sentry/PostHog) · URLs or query params · push or SMS
bodies · plaintext client storage (AsyncStorage/localStorage/cookies) · test fixtures · prompts to
any non-BAA service · any third party without a signed BAA.

- Log identifiers (resource IDs, correlation IDs), never PHI values.
- Sentry: `sendDefaultPii: false`, scrub request bodies/headers in `beforeSend`; Session Replay off
  or fully masked. PostHog: `autocapture: false`, sanitize in `before_send`, recording off/masked.
  Neither receives PHI even with a BAA.
- Test/seed data is synthetic and non-PHI. The pre-edit hook blocks SSN/MRN/DOB-shaped values.

## Access control

- Least privilege, default-deny, enforced via Medplum **AccessPolicy** (see `fhir.md`).
- Every PHI read/write is attributable to an authenticated principal.
- Never widen an AccessPolicy without explicit human approval — it's an approval-gated change.

## Audit

- `AuditEvent` / `Provenance` on PHI access, always on. Never disable, bypass, or sample.

## Secrets

- Never in the repo or client bundles. `.env` is gitignored; use the secret manager.
- No hardcoded keys/tokens/passwords. The pre-edit hook blocks common secret patterns.

## Data handling

- Encryption in transit and at rest; no PHI over non-TLS.
- Data minimization — request and store only what's needed.

## Payments

- **Stripe signs no BAA → Stripe never receives PHI.** No patient/diagnosis/service context in
  Stripe metadata, descriptors, or customer fields. Hard constraint.

## Approval gate

Adding any PHI-touching dependency or service is a human-approval decision. Vendors approved in
principle (BAA still required before prod PHI): Medplum Cloud, Vercel (Pro+HIPAA), Sentry, PostHog.
Unsure about any compliance question → **STOP and ask.**

## Review

Any change touching PHI, auth, or AccessPolicy runs the `security-reviewer` subagent before it's
done (definition of done). The pre-edit hook asks for confirmation on edits to sensitive files.
