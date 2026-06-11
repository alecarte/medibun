# Auth design — patients, staff, and the BFF

**Status: DESIGN DRAFT — pending Alec's review (Sprint 01, goal 6). Design only; implementing any
of this is approval-gated per CLAUDE.md (auth/authz/AccessPolicy).**

## Principals

| Principal | Surface                | Identity lives in                          | PHI access scope                         |
| --------- | ---------------------- | ------------------------------------------ | ---------------------------------------- |
| Patient   | patient-mobile, portal | Medplum (Patient + ProjectMembership)      | Own compartment only                     |
| Staff     | staff app              | Medplum (Practitioner + ProjectMembership) | Org-parameterized (ADR-0003)             |
| Service   | Bots, BFF system jobs  | Medplum ClientApplication                  | Narrow, per-purpose policies (not admin) |

## Recommendation: Medplum as the identity provider, brokered by the BFF

Patients and staff authenticate **to our BFF**, which runs the OAuth2 authorization-code (PKCE)
flow against Medplum **server-side** and holds the per-user Medplum session. Product apps never
see a Medplum token — preserving the anti-corruption boundary while every PHI access still happens
as the _end user's_ Medplum principal.

- **Web (portal, staff):** BFF session = opaque id in an HttpOnly, Secure, SameSite=Lax cookie.
  CSRF protection on mutating routes.
- **Mobile (patient-mobile):** BFF-issued opaque session token in `expo-secure-store` (never
  AsyncStorage — security.md bans plaintext client storage).
- **Session store:** server-side (Redis or the experience DB), holding the Medplum access/refresh
  tokens encrypted at rest. Our session tokens carry no PHI and no claims — opaque by design.

### Why this shape

1. **Attribution end to end** (security.md: "every PHI read/write attributable to an authenticated
   principal"): Medplum's own AuditEvents record the real end user, not a service account. This
   directly discharges the obligation pinned in `apps/api/src/app.ts` (AppDeps docs) when the
   vertical slice's dev guard is replaced.
2. **AccessPolicy enforced at the core:** patient-compartment policies for patients,
   Organization-parameterized templates for staff (ADR-0003) — the BFF is not the only line of
   defense.
3. **No new PHI-touching vendor:** Medplum is already BAA-tracked. An external IdP (Auth0, Clerk)
   would add a BAA + identity-mapping layer for little v1 gain.
4. **MFA included:** Medplum supports TOTP MFA — required for staff, optional for patients at v1.

### Alternatives rejected

- **Own user table + service-account Medplum access:** loses core-level attribution and policy
  enforcement (everything would look like the service account), and hand-rolls credential storage
  — the highest-risk option for a two-person team.
- **External IdP (Auth0/Clerk/Cognito):** new PHI-adjacent vendor, BAA + approval gate, and an
  identity-mapping layer between IdP subject and Medplum profile. Revisit only if we need social
  login or enterprise SSO.

## Flows (v1)

- **Patient signup:** BFF creates `Patient` + invites via Medplum (email verification); membership
  binds the patient AccessPolicy. Identity proofing beyond email is open Q2.
- **Login:** app → BFF `/auth/login` → server-side PKCE against Medplum → BFF session issued.
- **Logout/revocation:** BFF kills the session and revokes Medplum tokens; staff offboarding =
  membership deactivation (open Q4).
- **Staff onboarding:** admin-invited only; MFA enrollment mandatory before first PHI access.

## Hard rules (restating the constitution for this surface)

Medplum tokens never reach a client. Session tokens are opaque (no PHI, no claims). No auth state
in URLs or query params. Login endpoints rate-limited. The `/health/medplum` per-call
client-credentials login and the `API_DEV_UNAUTHENTICATED` dev guard are replaced — not extended —
by this design.

## Open questions (resolve at review)

1. Session lifetime/refresh policy (proposal: 30-day refresh, 15-min access, sliding).
2. Patient identity proofing at signup — email-only v1, or phone OTP too?
3. MFA for patients — optional v1, revisit before Handal migration (surgical records)?
4. Staff offboarding runbook — who deactivates memberships, and how fast?
5. Minors/guardianship (RelatedPerson access) — defer to Phase 2+?

## Approval gates before any implementation

Creating AccessPolicies (templates included) · wiring login flows · session storage choice ·
MFA policy · replacing the dev guard. Each lands via PR + security-reviewer; policy widening
always needs explicit human approval.
