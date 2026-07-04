# @medibun/medplum-backend

Server-side Medplum SDK wrappers — auth grants (direct login, client-credentials, token
refresh), FHIR reads/searches, scheduling (`$find`/`$book`), and the resource builders +
synthetic seeders. **Consumed by `apps/api` only**; a product app importing this is an
architecture violation (anti-corruption boundary, CLAUDE.md).

- `@medplum/*` packages are pinned in lockstep (same minor — currently 5.1.x); wire shapes the
  SDK doesn't type (e.g. `$find`/`$book` parameters) are source-verified against that version
  and unit-tested here.
- Seed data is synthetic and non-PHI, always (`.claude/rules/security.md`).

```bash
pnpm --filter @medibun/medplum-backend test   # Vitest, node environment
```
