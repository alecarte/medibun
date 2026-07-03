# Auth design — patients, staff, and the BFF

**Status: ACCEPTED 2026-06-11 (Sprint 01, goal 6) after adversarial validation against Medplum
5.1.x docs/source. Design only; implementing any of this is approval-gated per CLAUDE.md
(auth/authz/AccessPolicy).**

## Principals

| Principal | Surface                | Identity lives in                          | PHI access scope                         |
| --------- | ---------------------- | ------------------------------------------ | ---------------------------------------- |
| Patient   | patient-mobile, portal | Medplum (Patient + ProjectMembership)      | Own compartment only                     |
| Staff     | staff app              | Medplum (Practitioner + ProjectMembership) | Org-parameterized (ADR-0003)             |
| Service   | Bots, BFF system jobs  | Medplum ClientApplication                  | Narrow, per-purpose policies (not admin) |

## Recommendation: Medplum as the identity provider, brokered by the BFF

Patients and staff authenticate **to our BFF**, which uses **Medplum's direct-login API**
(`POST /auth/login` with code challenge → code exchange at `/oauth2/token`, confidential client)
and holds the per-user Medplum session server-side. Product apps never see a Medplum token —
preserving the anti-corruption boundary while every PHI access happens as the _end user's_
Medplum principal. (Precision note from review: this is Medplum's proprietary direct-login flow,
not the browser-redirect OAuth authorization-code flow; PKCE materials are server-held.)

- **Password transit rule (hard):** brokering means raw passwords pass through our UIs and the
  BFF. They are TLS-only, never logged, never stored, never echoed in errors, and discarded
  immediately after the Medplum exchange. Login request bodies are excluded from any logging
  middleware by construction.
- **Refresh tokens:** request scope `offline_access` (Medplum issues no refresh token otherwise);
  lifetime via `ClientApplication.refreshTokenLifetime` (target: 30 days), access tokens at
  Medplum's default 1 hour via `accessTokenLifetime`.
- **Web (portal, staff): same-origin proxy pattern.** The app's own origin proxies `/api/*` to
  the Hono BFF (Vercel rewrite), so the session cookie is host-only, first-party, and reaches the
  app's server components — which forward it on server-side BFF calls. This avoids the
  cross-origin cookie seam entirely (a separate API origin would never receive a SameSite cookie
  from server-side RSC fetches, and `*.vercel.app` previews are cross-site by the public suffix
  list). Cookie: opaque id, HttpOnly, Secure, SameSite=Lax, fresh id on every login (fixation),
  plus an Origin-header allowlist on mutating routes at the BFF (CSRF defense that doesn't depend
  on SameSite).
- **Mobile (patient-mobile):** BFF-issued opaque session token in `expo-secure-store` with
  `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY` (values ≤ 2 KB — fine for an opaque id);
  never AsyncStorage (security.md bans plaintext client storage). Sent as a header.
- **Session store: Neon (decided).** Not Redis — on Vercel that means a new PHI-adjacent vendor
  (Upstash BAA is Enterprise-only) and a CLAUDE.md vendor-approval gate; Neon is already approved
  (ADR-0002) and Postgres row locking is needed anyway (below). Medplum access/refresh tokens are
  stored with **application-level encryption (AES-256-GCM)**, key in the secret manager (never
  the DB), with a rotation plan — a database dump must not yield usable Medplum tokens. Disk-level
  encryption alone is insufficient for bearer credentials to PHI.
- **Refresh serialization:** Medplum rotates the refresh secret on _every_ refresh with strict
  invalidation and no reuse grace window — concurrent serverless refreshes can brick a session.
  Refreshes are serialized per session via `SELECT … FOR UPDATE` on the session row (re-read the
  token after acquiring the lock, refresh inside it).
- **Login rate limiting:** durable counters (Neon sliding window) and/or Vercel WAF — there is no
  in-memory state on serverless. **Upstream cap (launch-critical):** Medplum's `/auth/login`
  default limit is ~5 requests/min/IP, and all brokered logins egress from a small shared Vercel
  IP pool. Dev self-host: raise `defaultLoginRateLimit` in server config. **Medplum Cloud: the
  project `loginRateLimit` must be raised by Medplum — add to the BAA/onboarding checklist.**
- **Opaque tokens by design:** every BFF request costs a Neon session lookup. Accepted — do not
  "optimize" into a claims-bearing JWT without a security review.

### Why this shape

1. **Attribution end to end** (security.md): with per-user sessions, Medplum AuditEvents record
   the real end user. **Conditional, not automatic:** RESTful AuditEvents are emitted only when
   the server's `logAuditEvents` setting is on, and they go to the log stream. Dev: enable
   `logAuditEvents: true` in `infra/medplum` and verify an end-user-attributed event appears.
   **Medplum Cloud: audit log streaming is enabled by Medplum — BAA/onboarding checklist item.**
   This discharges the obligation pinned in `apps/api/src/app.ts` (AppDeps docs).
2. **AccessPolicy enforced at the core:** patient-compartment policies for patients,
   Organization-parameterized templates for staff (ADR-0003) — the BFF is not the only line of
   defense.
3. **No new PHI-touching vendor:** Medplum is already BAA-tracked; the session store is Neon
   (already approved). An external IdP (Auth0, Clerk) would add a BAA + identity-mapping layer
   for little v1 gain.
4. **MFA (TOTP) exists in Medplum** — but "required" is enforced **per user at invite time**
   (`mfaRequired: true`); there is no project/role-level switch. Staff invites always set it, and
   a periodic audit query flags staff memberships without MFA enrollment. Note the cost honestly:
   the MFA enrollment + verify UX must be **brokered through the BFF and built in our apps**
   (Medplum's hosted UI is off-limits under the boundary) — budget it with the auth
   implementation.

### Alternatives rejected

- **Own user table + service-account Medplum access:** loses core-level attribution and policy
  enforcement (everything would look like the service account), and hand-rolls credential storage
  — the highest-risk option for a two-person team.
- **External IdP (Auth0/Clerk/Cognito):** new PHI-adjacent vendor, BAA + approval gate, and an
  identity-mapping layer between IdP subject and Medplum profile. Revisit only if we need social
  login or enterprise SSO.
- **On-Behalf-Of impersonation (`X-Medplum-On-Behalf-Of`) for end-user reads:** considered as a
  way to avoid storing per-user refresh tokens. **Rejected.** OBO is authorization-only — it does
  not authenticate the end user, so the brokered direct-login flow (password/MFA) is required
  regardless; OBO would only remove token storage/refresh. The cost is disqualifying: it requires
  the BFF ClientApplication to hold **Project-Admin** (Medplum docs: "The only requirement … is
  that it has Project Admin rights"), which (a) violates the binding least-privilege rule and the
  "service principal is not admin" constraint, (b) creates a standing credential that structurally
  spans the Handal + Aureva tenant boundary (against ADR-0003's policy-enforced isolation), and
  (c) turns per-request tenant scoping into a fail-open "was the header sent" property. Brokered
  per-user tokens keep the blast radius bounded to active sessions, each confined by the user's own
  AccessPolicy, with clean end-user audit attribution. Verified against `@medplum/core` 5.1.9 (OBO
  is header-only in this version; impersonated requests also lose SDK request caching). Revisit
  only for a future internal admin/clinical-ops impersonation surface — not the patient/staff path.

## Flows (v1)

- **Patient signup:** BFF invites via Medplum admin API (`POST /admin/projects/:id/invite`) →
  `Patient` + membership binds the patient AccessPolicy. Email verification at v1; phone OTP when
  online booking launches (decided). The signup endpoint is an unauthenticated account-creation
  surface: rate-limited + bot-protected (CAPTCHA or equivalent) from day one.
- **Login:** app → BFF `/auth/login` → Medplum direct-login + code exchange server-side → fresh
  BFF session issued.
- **Logout/revocation:** BFF kills the session **locally and authoritatively** (revokes the
  session row, clears its stored tokens) and **best-effort**-revokes the Medplum `Login` by id.
  The Medplum-side revoke currently 403s — the service ClientApplication has no AccessPolicy on
  the `Login` resource — so it's logged, not fatal; the cleared access token is unreachable and
  expires within the hour. **Approval-gated follow-up:** grant the service client `Login`
  read/write (a scoped AccessPolicy) and make upstream revocation authoritative. Revocation, once
  it lands, takes effect on Medplum's next request check (`login.revoked` is checked per request).
  Note (verified against Medplum 5.1.9): `POST /auth/revoke` is **not** an option for the backend
  — its handler is self-scoped (rejects any login whose user ≠ the caller's, returning notFound),
  so a service account cannot revoke a patient's login through it. The `Login.revoked` update is
  the only backend-driven path, hence the AccessPolicy grant is the real unblock.
- **Staff onboarding:** admin-invited only (`mfaRequired: true`); MFA enrollment mandatory before
  first PHI access. **Offboarding (decided): Alec, same business day, written checklist — revoke
  ALL active Logins for the user (admin query), deactivate the membership.**
- **MFA for patients:** optional at v1; revisit before the Handal migration (decided).

## Hard rules (restating the constitution for this surface)

Medplum tokens never reach a client. Session tokens are opaque (no PHI, no claims). No auth state
in URLs or query params. Login endpoints rate-limited (durable). Raw passwords never logged or
stored. The `/health/medplum` per-call client-credentials login and the `API_DEV_UNAUTHENTICATED`
dev guard are replaced — not extended — by this design.

## Deferred (decided at review, 2026-06-11)

- Minors/guardianship (`RelatedPerson` access): Phase 2+.
- Break-glass cross-practice access: own approval-gated design, later.

## Approval gates before any implementation

Creating AccessPolicies (templates included) · wiring login flows · session-token encryption keys
· MFA policy · granting the BFF account-tagging rights (`$set-accounts`, see DATA_MODEL.md) ·
replacing the dev guard. Each lands via PR + security-reviewer; policy widening always needs
explicit human approval.

## Review log

- **2026-06-11 — accepted** (Alec) after adversarial validation. Corrections applied: flow named
  accurately (direct-login API; password-transit rule); `offline_access` + lifetime knobs;
  same-origin proxy pattern for web sessions; Neon-only session store with app-level encryption;
  refresh-race serialization; durable rate limiting + Medplum upstream login-cap as an onboarding
  item; AuditEvent emission made an explicit per-environment verification; MFA enforcement
  mechanics + brokered-UX cost; signup abuse controls; offboarding revokes all Logins.
- **2026-07-01 — hardening after multi-agent code review** (approved by Alec). Undecryptable
  stored tokens (key rotation/corruption) now invalidate the session (revoke + 401) instead of
  500ing; sessions are revoked **only** on a definitive refresh rejection
  (`RefreshRejectedError`, Medplum 400/401) — transient failures keep the session; the refresh
  fetch is bounded (15s) below `statement_timeout` (30s) and `idle_in_transaction` (60s) so a
  succeeding grant is never killed mid-rotation; migrations wired into setup-dev/CI plus a boot
  fail-fast; the FOR UPDATE concurrency suite now runs in CI against a real Postgres; graceful
  shutdown drains the server and closes the pool. Verified against Medplum v5.1.9 source:
  `/auth/login` returns `code` XOR `memberships`, so the single-membership guard cannot
  false-positive. Deferred consciously: centralized domain-error→HTTP mapping (when the third
  auth route lands) and env-tunable auth constants.
- **2026-07-02 — v0 staff-MFA decision** (Alec, via the v0 proposal's A4 ask — see
  `docs/V0_PROPOSAL.md` §5): for the synthetic-data-only v0, dev staff accounts are invited
  **without** `mfaRequired`; the brokered TOTP enroll/verify flow is an early post-v0 slice and
  is **required before any real staff account exists**. The "staff invites always set
  `mfaRequired: true`" rule stands for real accounts; this is a scoped, recorded exception for
  synthetic dev identities only.
- **2026-07-02 — S2 portal patient auth shipped** (v0 proposal S2). Portal login/logout UI +
  `/account` on the same-origin `/api` proxy (Next rewrite → BFF; HttpOnly cookie stays
  first-party). The **`API_DEV_UNAUTHENTICATED` dev route and portal `/dev/patient` page are
  REMOVED** (the decided replace-not-extend item — done); a regression test pins `/patients/:id`
  to 404. First AccessPolicy landed: **`patient-self-v1`** (read-only own-compartment template,
  `%patient` criteria verified against the v5.1.9 server source incl. read-by-id enforcement),
  upserted + membership-bound by `setup-dev.sh` with a fail-loud binding check (the server
  silently drops malformed criteria — hence the check). The end-to-end login flow was
  live-verified in a browser against the real BFF/session store with only Medplum's four
  endpoints faked (`apps/api/scripts/e2e-harness.ts`, synthetic data).
- 2026-07-03 — Live-Medplum caveat CLOSED: `setup-dev.sh` ran clean on Alec's WSL2 stack
  against a real Medplum — policy read-back 8/8 resource entries, membership-pinned
  `patient-self-v1` binding confirmed by the fail-loud check. The policy path is now
  live-exercised end-to-end.
- 2026-07-03 — Note for the deferred signup/phone-OTP decision (no change to accepted
  decisions): the booking-conversion research (`BOOKING_DESIGN.md`) strengthens the case for
  **guest-first booking with SMS-code identity** when signup lands — forced account creation
  is the #2 booking-abandonment cause (Baymard), the premium field's best practice is
  identity-after-slot-selection (Boulevard) or fully login-free SMS recognition (Mangomint),
  and this dovetails with the already-decided "phone OTP when online booking launches."
  Design the signup slice against BOOKING_DESIGN.md §4 when it's scheduled.
