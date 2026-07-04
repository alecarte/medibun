# @medibun/api

The BFF (ADR-0001) — the **only** process that holds a Medplum session. It brokers auth, owns
the experience DB (non-clinical data: sessions, service catalog; later memberships/loyalty/
wallet), translates domain operations to/from FHIR, and shapes responses for the product apps.

- **HTTP contract**: [`docs/API.md`](../../docs/API.md). Clients use `@medibun/api-client`.
- **Auth design**: [`docs/AUTH.md`](../../docs/AUTH.md).
- **PHI invariants** (binding, see `.claude/rules/security.md`): logs carry identifiers only —
  never bodies, headers, or query strings; client-facing errors are generic codes + request id.

```bash
pnpm --filter @medibun/api dev          # tsx watch (needs infra/medplum/.env — see root README)
pnpm --filter @medibun/api db:migrate   # experience-DB migrations (Drizzle)
pnpm --filter @medibun/api test         # Vitest (PGlite for DB tests — no Docker needed)
```

Env: `MEDPLUM_*` + `EXPERIENCE_DATABASE_URL` + `SESSION_ENCRYPTION_KEY` + `API_ALLOWED_ORIGINS`
are written by `infra/medplum/setup-dev.sh`. Auth/booking routes mount only when that wiring is
present; without it the server still boots with `/health` (and logs why).
