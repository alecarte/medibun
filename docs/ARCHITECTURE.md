# Architecture

Seeded from `PROJECT_BRIEF.md` and the bootstrap decisions. Read this (with `DATA_MODEL.md` and
`ROADMAP.md`) before non-trivial work. This is a living document — it describes the intended shape,
not a finished system.

## Mission in one line

An owned, FHIR-native clinical platform on **Medplum** that is the single record of truth for two
practices — **Handal Plastic Surgery** (surgical; migrates off the 4D EMR later) and **Aureva
Medspa** (greenfield; launches first) — with three product surfaces and a growth engine.

## System shape

```
        product apps (clients)
  ┌───────────────┬───────────────┬────────────────────┐
  │ patient-mobile│   portal      │      staff         │
  │ (Expo/RN)     │ (Next.js RSC) │  (Next.js RSC)     │
  └───────┬───────┴───────┬───────┴─────────┬──────────┘
          │  @medibun/api-client (typed BFF client; domain shapes, not FHIR)
          ▼               ▼                 ▼
  ┌─────────────────────────────────────────────────────┐
  │                 OUR BACKEND (the BFF)                 │  ← only holder of the Medplum SDK
  │  • owns experience data (its own DB)                  │
  │  • translates domain ⇄ FHIR                           │
  │  • orchestrates third parties                         │
  └───────┬───────────────────────┬──────────────────────┘
          │                       │
          ▼                       ▼
   ┌─────────────┐      ┌───────────────────────────────┐
   │  Medplum    │      │ Stripe · DoseSpot · comms ·    │
   │  (clinical  │      │ Sentry · PostHog (integrate,   │
   │  source of  │      │ never rebuild; BAA-gated;      │
   │  truth)     │      │ Stripe never sees PHI)         │
   └─────────────┘      └───────────────────────────────┘
   Bots + Subscriptions = growth/clinical event engine (on-platform, no polling)
```

## Anti-corruption boundary (binding)

Product apps talk **only** to our backend via `@medibun/api-client`, never to Medplum or any EMR
directly. The backend is the sole holder of the Medplum SDK (server-side `MedplumClient`). This
isolation is what lets us evolve the core, swap/augment it, and add tenants later without touching N
client apps. `@medibun/fhir-types` is types-only; importing it doesn't breach the boundary, but
prefer domain DTOs at the app edge.

> The brief listed "Medplum React SDK" for the apps AND "apps never talk to Medplum directly." These
> contradict; we resolved in favor of the boundary (BFF). Letting a product app hold a Medplum
> session is an architecture-review item.

## The BFF flavor (chosen: thick BFF that owns experience data)

Of three possible flavors — (1) thin proxy, (2) thick BFF owning experience data + orchestration,
(3) full microservices — we chose **#2**, which is what the brief's data model implies.

- The backend holds **its own database** for the brief's non-clinical "experience data":
  memberships, loyalty/rewards, app preferences, push tokens, growth-journey state.
- It **translates** domain operations to/from FHIR and **orchestrates** the third parties.
- **Medplum is the clinical source of truth.** Reconcile the two stores by patient ID.

Not #1 (a thin proxy can't host loyalty/membership/growth logic, which isn't FHIR — we'd grow into
#2 anyway). Not #3 (premature at two practices; #2 is a modular monolith we can carve into services
later if scale demands).

### Boundary discipline (protect this line)

- Clinical + event-driven logic → **Medplum Bots / Subscriptions**.
- Experience data + third-party orchestration + client-shaping → **BFF**.

Keeping this line clean is what stops the BFF bloating into #3 or duplicating Medplum's own features
(search, subscriptions, GraphQL, audit).

### Known itches + additive escape valves (none require leaving #2)

- **Latency / double round-trip** → allow *selective* direct FHIR **reads** from the staff app via
  the Medplum SDK + AccessPolicy later (writes/orchestration stay behind the BFF). Keep
  `api-client` shaped so a read-through path can be added without a rewrite.
- **DTO⇄FHIR translation drift** → codegen from FHIR profiles, or share `@medplum/fhirtypes` for
  FHIR-shaped slices (the reason `fhir-types` exists as a types-only package — it's the seam).
- **Duplicating Medplum** → push clinical/event logic into Bots/Subscriptions, not the BFF.
- **Realtime / offline for the consumer app** → Medplum Subscriptions → BFF → push, plus TanStack
  Query optimistic mutations; a WebSocket/SSE layer on the BFF is additive if true sync is needed.

## Two sources of truth

- **Medplum** — clinical data (FHIR).
- **Our DB** — experience data (memberships, loyalty, preferences, push tokens, growth state).

Reconcile by patient ID. Never blur them.

## Consumer app + platform API ("Starbucks for MedSpa")

The patient surfaces (`patient-mobile` + `portal`) are the consumer experience: memberships,
loyalty points/rewards, services, messaging, purchasing products/services, and **proactive
recommendations**. This is not a new requirement — it's the realized form of the surfaces already
scaffolded, and it's exactly what the BFF enables.

The **platform API** (the BFF's domain surface, consumed via `@medibun/api-client`) is what lets
this app — and future custom apps once we productize to more practices — plug in against a stable
contract while clinical data stays behind the boundary. Anticipated domain areas (modeled in Phase
1+, not now):

- **Memberships** — plans, status, billing (via Stripe; never with PHI in Stripe).
- **Loyalty / rewards** — points, tiers, redemptions (experience data, our DB).
- **Catalog / services** — bookable services and purchasable products.
- **Messaging** — patient ⇄ practice (PHI-aware; stays behind the boundary).
- **Recommendations** — proactive, event-driven on Medplum Bots/Subscriptions.
- **Purchasing** — products/services checkout (Stripe; PHI-free).

Multi-brand/multi-tenant: brands are token sets (see Theming) + per-tenant config; future practices
onboard under their own brand against the same API. Detailed endpoint/data design is Phase-1 work —
**ask before modeling**.

## Theming (runtime, multi-brand)

`@medibun/design-tokens` is the single source of truth: DTCG-format tokens built with Style
Dictionary into (a) web CSS variables + a Tailwind v4 `@theme` and (b) a `@shopify/restyle` theme
object for mobile. Brand colors and logos are **runtime-configurable** for a future in-app settings
GUI — web swaps a `[data-brand]` CSS-variable scope; mobile swaps the restyle `ThemeProvider`. Never
hardcode brand values. Cross-platform theme sync is solved here (shared neutral tokens), not by
sharing a styling engine.

## Medplum deployment (dev vs prod)

- **Dev:** a **self-hosted Medplum server runs locally via Docker Compose** (`infra/medplum/`,
  pinned 5.1.9). Synthetic data only; no BAA needed (our infrastructure, never exposed). See
  `infra/medplum/README.md`.
- **Prod (later):** **Medplum Cloud** (Phase 1), which requires the Medplum BAA before any real PHI.
- The Medplum SDK lives only in `packages/medplum-backend` (the first slice of the backend/BFF) —
  never in the product apps. `createMedplumClient` reads connection + credentials from the
  environment; the local Subscription→Bot loop is proven by
  `packages/medplum-backend/src/scripts/verify-subscription.ts`.

## Stack (locked)

Monorepo: pnpm 11 + Turborepo 2, TypeScript 6 strict. Web (`portal`, `staff`): Next 16 App Router
RSC + React 19/Compiler, Tailwind v4 + shadcn/ui, Motion. Mobile (`patient-mobile`): Expo SDK 55
(New Arch), Expo Router, `@shopify/restyle`, Reanimated 4. Shared: `design-tokens`, `fhir-types`
(types-only), `api-client` (BFF client). Testing: Vitest+RTL (web/packages), jest-expo (mobile).
Core (deferred): Medplum Cloud. Observability (deferred, BAA + PHI-scrub): Sentry, PostHog.

See `CLAUDE.md` for the binding rules and the full version pins.

## Compliance posture

PHI lives only in Medplum and our backend (both under BAA before prod). Stripe never sees PHI. All
PHI-touching vendors are human-approval, BAA-gated. Least-privilege AccessPolicy + always-on audit.
See `.claude/rules/security.md` and `.claude/rules/fhir.md`.
