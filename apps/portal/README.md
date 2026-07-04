# @medibun/portal

The patient portal — Next 16 App Router (RSC), React 19, Tailwind v4 on `@medibun/design-tokens`.
Register: **premium consumer** (`docs/DESIGN.md`, `docs/BOOKING_DESIGN.md`).

**Boundary (binding)**: talks only to the BFF via `@medibun/api-client`, through the same-origin
`/api` proxy (Next rewrite → `API_BASE_URL`) so the session cookie stays first-party. Never
imports a Medplum SDK. No PHI in URLs, query params, client storage, or logs.

```bash
pnpm --filter @medibun/portal dev    # http://localhost:3100 (BFF must be running — root README)
pnpm --filter @medibun/portal test   # Vitest + RTL (jsdom)
```

Shell notes: sidebar collapse preference is a non-PHI cookie (server-rendered first paint);
⌘/Ctrl+B toggles it; ⌘/Ctrl+K is reserved for search/concierge (S10).
