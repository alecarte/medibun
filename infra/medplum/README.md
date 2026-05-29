# Local Medplum (self-hosted dev)

Self-hosted Medplum stack for **local development only**. Production will run on **Medplum Cloud**
(see [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)). Pinned to Medplum **5.1.9** — keep the
`@medplum/*` client packages on the same version. (5.1.13 has a SubscriptionQueue
`cappedExponential` backoff regression that breaks bot execution; 5.1.9 is known-good here.)

> ⚠️ **Dev only. Synthetic data only. Never expose this on a public network, and never put real
> PHI in it.** The seeded admin credentials below are well-known defaults.

## Start

```bash
cd infra/medplum
docker compose up -d
```

First boot takes a few minutes — the server runs DB migrations and seeds a default project before
its healthcheck passes. Then:

- **App (web UI):** http://localhost:3000
- **API server:** http://localhost:8103
- Postgres on 5432, Redis on 6379.

## Log in

Seeded super-admin (dev default):

- email: `admin@example.com`
- password: `medplum_admin`

## Provision dev credentials (for the backend)

Run the setup script once the stack is healthy. It logs in as the seeded admin, enables the
project's `bots` feature, creates a ClientApplication and a Bot (with the ProjectMembership a bot
needs to execute), and writes the gitignored `infra/medplum/.env`:

```bash
cd infra/medplum
./setup-dev.sh
```

Re-run it after `docker compose down -v` (a volume wipe resets the DB). Requires `jq` and
`openssl` (both standard on macOS). **Never commit `.env`.** You can also create the
ClientApplication/Bot manually in the app UI (http://localhost:3000) if you prefer.

## Stop / reset

```bash
docker compose down          # stop, keep data
docker compose down -v       # stop and DELETE the postgres volume (full reset)
```

## Notes

- **Apple Silicon:** images are multi-arch; they run native arm64. Do **not** add
  `platform: linux/amd64` (forces slow emulation).
- **Bots** run in-process via VM context (`MEDPLUM_VM_CONTEXT_BOTS_ENABLED=true`) — no AWS Lambda
  locally. This is not a security sandbox; fine for trusted local dev.
- **Subscriptions** are handled by the in-server worker (Redis-backed) — no extra container.
