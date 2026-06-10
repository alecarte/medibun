# ADR-0001: BFF runtime

- **Status:** Accepted (Alec, 2026-06-10)
- **Date:** 2026-06-10
- **Sprint:** 01, goal 2 (see `docs/sprints/2026-06-10-sprint-01.md`)

## Context

The architecture requires a backend (BFF) that is the **only Medplum SDK holder**, owns the
experience database, translates domain operations to/from FHIR, orchestrates third parties
(Stripe, push, comms), and serves the three product apps via `@medibun/api-client`
(see `docs/ARCHITECTURE.md`). No backend app exists yet; this ADR picks its runtime.

Constraints:

- **Hosting:** Vercel is the approved-in-principle host. HIPAA BAA is available on **Pro as a
  $350/mo add-on** (click-through agreement) or **Enterprise** (signed BAA + Secure Compute).
  Needed before production PHI, not for local/synthetic dev.
- **Workload shape:** request/response domain API + third-party webhook receivers (Stripe).
  Clinical event logic stays on Medplum Bots/Subscriptions — the BFF does not poll or run
  long-lived background loops.
- **Constitution:** simplicity first; minimal, well-maintained dependencies; the runtime must not
  pull UI/React machinery into the backend.

## Options considered

### A. Hono app in `apps/api` (recommended)

Web-standard (Fetch API) backend framework; first-class zero-config support on Vercel, where
routes become Vercel Functions on Fluid compute (cold-start optimizations, `waitUntil`
background work, streaming).

- (+) Tiny, TypeScript-first, no UI baggage; middleware model fits PHI-safe logging/error
  handling as a small explicit stack.
- (+) Portable across runtimes (Node, Bun, workers, containers) — if we ever leave Vercel or
  self-host next to a self-hosted Medplum, the app moves unchanged. Aligns with the owned-core,
  anti-lock-in thesis.
- (+) Trivially testable: `app.request()` runs the whole app in-process under Vitest — no server
  spawn, fits the existing test setup.
- (+) Typed RPC option (`hono/client`) available later for `@medibun/api-client` if we want
  end-to-end inferred types without codegen.
- (−) One more framework in the repo (the web apps are Next).

### B. Next.js route handlers (dedicated Next app as the API)

- (+) One framework everywhere; zero new concepts on Vercel.
- (−) Drags the React/RSC toolchain into a backend that renders nothing.
- (−) Blurs the binding boundary between "product app" and "the backend" — the constitution
  treats apps as Medplum-free zones, and an API-that-is-also-a-Next-app invites erosion.
- (−) Route-handler ergonomics (middleware, typed clients, testing) are weaker than a dedicated
  backend framework's.

### C. Fastify (long-running Node server)

- (+) Mature, fast, rich plugin ecosystem; no serverless constraints.
- (−) Doesn't fit Vercel's function model — would push us to a second host (Railway/Fly/ECS),
  which means a second BAA conversation and more ops surface now.
- (−) We don't yet have a workload that needs a resident process; Bots cover event-driven work.

## Decision (proposed)

**Option A — Hono in `apps/api`, deployed to Vercel (Fluid compute), local dev via
`@hono/node-server`.** Revisit only if a workload appears that genuinely needs a resident
process (then Fastify/containers is the escape valve; Hono code ports without rewrite).

## Consequences

- `apps/api` joins the workspace with the standard scripts (typecheck/lint/test/build) and runs
  under the existing CI.
- `@medibun/medplum-backend` is consumed only by `apps/api`; the SDK-holder boundary gets a real
  enforcement point.
- `@medibun/api-client` gets a base URL + typed domain methods targeting `apps/api`.
- Production deploy requires the Vercel HIPAA add-on **before any real PHI** (user TODO,
  tracked with the BAA paperwork). Local dev against docker-compose Medplum needs nothing.
