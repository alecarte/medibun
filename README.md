# Medibun

Multi-tenant MedSpa/aesthetics platform on a Medplum FHIR core. Architecture, data model, and
roadmap live in [`/docs`](docs/) ([`docs/README.md`](docs/README.md) is the map — including the
BFF API reference in [`docs/API.md`](docs/API.md)); the v0 cut and slice status live in
[`docs/V0_PROPOSAL.md`](docs/V0_PROPOSAL.md). Each app/package has its own short README. **Local
dev is synthetic data only — never real PHI.**

## Prerequisites

- **Node ≥ 22.18** (see `engines` in package.json)
- **pnpm 11** — `corepack enable && corepack prepare pnpm@11.4.0 --activate` (upgrade corepack
  itself first if activation fails: `npm i -g corepack@latest`)
- **Docker** with compose (on Windows: Docker Desktop with WSL2 integration enabled)
- `jq`, `curl`, `openssl` (setup-dev.sh preflights these)

## Run locally

```bash
pnpm install

# 1. Start + configure the local Medplum stack (writes infra/medplum/.env on success)
cd infra/medplum && docker compose up -d && ./setup-dev.sh && cd ../..

# 2. Seed synthetic demo data into Medplum + the experience DB (idempotent; re-run anytime)
pnpm demo:seed

# 3. Run the BFF + both web apps (builds workspace packages first)
pnpm dev:apps
```

| Surface                  | URL                   | Notes                                          |
| ------------------------ | --------------------- | ---------------------------------------------- |
| Patient portal           | http://localhost:3100 | Log in with the demo patient from setup-dev.sh |
| Staff app                | http://localhost:3200 | Staff auth lands in S5                         |
| BFF (`apps/api`)         | http://localhost:3001 | Health: `/health`, `/health/medplum`           |
| Medplum app (admin UI)   | http://localhost:3000 | Manage the FHIR project directly               |
| Medplum FHIR server      | http://localhost:8103 |                                                |
| Experience DB (Postgres) | localhost:5433        | `medibun/medibun`, db `medibun_experience`     |

`pnpm dev:apps` scopes to the API + web apps; plain `pnpm dev` also starts the Expo dev server
for `patient-mobile` (stubbed in v0). The portal reaches the BFF through its own same-origin
`/api` proxy (Next rewrite → `API_BASE_URL`, default `localhost:3001`), so the session cookie
stays first-party; the BFF only accepts mutating auth requests from the origins in
`API_ALLOWED_ORIGINS` (setup-dev.sh writes the 3100/3200 dev defaults).

## Everyday commands

```bash
pnpm typecheck · pnpm lint · pnpm test · pnpm build   # whole workspace, via Turbo
pnpm --filter @medibun/<name> <script>                # one package
pnpm format                                           # Prettier
```

Testing is split by design: Vitest + RTL for web/packages, jest-expo for mobile (see
`.claude/rules/testing.md`). For screenshot-reviewing UI without the full Medplum stack, use the
stub-BFF + Playwright harness in [`tools/visual-check/`](tools/visual-check/README.md).

## Troubleshooting

- **`Medplum env not found`** — `setup-dev.sh` didn't complete; it writes `infra/medplum/.env`
  as its last step. Re-run it (idempotent).
- **Stale workspace builds** — `dev:apps` and `demo:seed` build dependencies first via Turbo;
  if something still looks stale, `pnpm build`.
- **Login 403 `forbidden_origin`** — the BFF logs the exact rejected origin
  (`"detail":"origin rejected: …"`) in the `@medibun/api:dev` output. The allowlist is an
  EXACT string match against `API_ALLOWED_ORIGINS` in `infra/medplum/.env`; re-run
  `setup-dev.sh` for current defaults (localhost + 127.0.0.1 on 3100/3200), make sure you
  browse via one of those URLs, and restart `pnpm dev:apps` after any `.env` change (the
  env file is read at process start only).
- **Reset the local stack** — `cd infra/medplum && docker compose down -v` (destroys all local
  Medplum + experience data), then repeat setup.
