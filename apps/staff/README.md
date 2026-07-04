# @medibun/staff

The staff app — Next 16 App Router, React 19, Tailwind v4 on `@medibun/design-tokens`. Register:
**quiet tool** (dense, calm, fast — `docs/DESIGN.md`). Shell only until S5 (staff auth +
foundation); the schedule/ops surfaces land in later slices.

**Boundary (binding)**: same as the portal — BFF via `@medibun/api-client` only, never a Medplum
SDK, no PHI in URLs/storage/logs.

```bash
pnpm --filter @medibun/staff dev    # http://localhost:3200
pnpm --filter @medibun/staff test   # Vitest + RTL (jsdom)
```
