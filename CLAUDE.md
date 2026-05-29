# CLAUDE.md — Operating Constitution

This file is the binding constitution for work in this repository. It is rendered from
`PROJECT_BRIEF.md` §4 and **overrides convenience, speed, and any request**. If a change would
violate a rule here, **refuse and explain** rather than comply. When a compliance question is
unclear, **STOP and ask** — never guess on HIPAA, access, or audit.

`PROJECT_BRIEF.md` remains the authoritative record of what we're building and the decisions
already made; read it for context. This file governs *how* we work.

---

## Working principles

1. **Think before coding** — state assumptions explicitly; present alternatives instead of picking
   silently; push back when a simpler path exists; ask when anything is unclear.
2. **Simplicity first** — the minimum code that solves the problem; no speculative abstraction, no
   unrequested flexibility, no error handling for impossible cases.
3. **Surgical changes** — touch only what the task requires; match existing style; don't refactor
   what isn't broken; every changed line traces directly to the request.
4. **Goal-driven execution** — turn each task into a verifiable goal and loop until met (write the
   failing test first, then satisfy it); state a short plan with a verify step per item.
5. **Whole-repo awareness** — before non-trivial work, read `/docs/ARCHITECTURE.md`,
   `/docs/DATA_MODEL.md`, and `/docs/ROADMAP.md`; keep the system-wide view.

**Calibrate to the task.** Trade speed for caution on non-trivial work; exercise judgment on
trivial tasks — don't apply heavy ceremony to a one-line fix. The principles are a discipline, not
a bureaucracy.

**Success indicators** (the principles are working when): fewer unnecessary diff changes; fewer
rewrites caused by over-engineering; clarifying questions asked *upfront* rather than corrections
needed after implementation.

## Security & HIPAA — non-negotiable

- PHI never leaks into: logs, error messages, analytics/telemetry, URLs or query params, push or
  SMS bodies, plaintext client storage, prompts to any non-BAA service, or any third party without
  a signed BAA.
- Least privilege, default-deny, enforced through Medplum AccessPolicy; every PHI read/write
  attributable to an authenticated principal; never widen a policy without human approval.
- Audit always on — FHIR `AuditEvent` / `Provenance` on PHI access; never disable, bypass, or
  sample.
- Secrets never in the repo or client bundles; `.env` is gitignored; use the secret manager.
- Data minimization; encryption in transit and at rest; no PHI over non-TLS.
- Adding any PHI-touching dependency or service is a human-approval decision; prefer minimal,
  well-maintained dependencies.
- Unsure about a compliance question → STOP and ask. Never guess on HIPAA, access, or audit.

## Definition of done

typecheck + lint + tests pass; new behavior has tests; no secrets or PHI in the diff, logs, or
fixtures; access policy reviewed for any new PHI-touching endpoint; small diff where every line
traces to the request; the `security-reviewer` subagent has run on any change touching PHI, auth,
or AccessPolicy.

## Requires explicit human approval (never auto-execute)

Destructive or irreversible operations (data deletion, dropping tables, force-push, prod deploys);
schema or FHIR data-model migrations; anything touching authentication, authorization, or
AccessPolicy; adding a new PHI-touching dependency or service; disabling, weakening, or bypassing
any security control or test.

---

## Architecture invariants (binding)

These follow from the brief and decisions made during bootstrap. Treat them like the rules above.

- **Anti-corruption boundary.** The product apps (`apps/patient-mobile`, `apps/portal`,
  `apps/staff`) talk only to **our backend (the BFF)** via `@medibun/api-client` — never to Medplum
  or any EMR directly. Only the backend imports a Medplum SDK / holds a Medplum session. Do not add
  `@medplum/react`, `@medplum/react-hooks`, or `MedplumClient` to a product app. Letting a product
  app hold a Medplum session is an architecture-review item.
- **BFF is thick (owns experience data).** The backend owns its own database for non-clinical
  "experience data" (memberships, loyalty, preferences, push tokens, growth state), translates
  domain operations to/from FHIR, and orchestrates third parties. **Medplum is the clinical source
  of truth.** Reconcile by patient ID.
- **Boundary discipline.** Clinical + event-driven logic → Medplum Bots/Subscriptions. Experience
  data + third-party orchestration + client-shaping → BFF. Keep this line clean; do not duplicate
  Medplum features in the BFF.
- **Two sources of truth.** Medplum (clinical) and our DB (experience). Never blur them.
- **Stripe never receives PHI.** Stripe signs no BAA. No patient/diagnosis/service context in
  Stripe metadata, descriptors, or customer fields — a hard design constraint, not just config.
- **Design tokens are the single source of truth for theming.** `@medibun/design-tokens` (DTCG +
  Style Dictionary) emits web CSS variables / Tailwind `@theme` and the mobile restyle theme. Brand
  colors/logos are runtime-configurable (web `[data-brand]`, mobile restyle `ThemeProvider`); never
  hardcode brand values.

## Stack (locked — see PROJECT_BRIEF.md §3 and bootstrap decisions)

- Monorepo: pnpm 11 workspaces + catalogs, Turborepo 2 (`tasks`), TypeScript 6 `strict`.
- Web (`portal`, `staff`): Next 16 App Router (RSC), React 19 + React Compiler, Tailwind v4 +
  shadcn/ui, Motion (`motion/react`).
- Mobile (`patient-mobile`): Expo SDK 55 (New Arch), Expo Router, **@shopify/restyle** (not
  NativeWind), Reanimated 4.
- Shared: `design-tokens`, `fhir-types` (types-only), `api-client` (BFF client).
- Testing: **Vitest + RTL** for web/packages; **jest-expo + RTL-native** for mobile. Two runners by
  design — do not force one runner across the repo.
- Core (deferred to its approval gate): Medplum Cloud (`@medplum/*` 5.1.x, lockstep).
- Observability (deferred, BAA + PHI-scrub required): Sentry (PHI-scrubbed), PostHog (no PHI).

## Commands

- `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm build` — run across the workspace via Turbo.
- `pnpm format` / `pnpm format:check` — Prettier.
- Per package: `pnpm --filter @medibun/<name> <script>`.

## Conventions

- Web/package source uses explicit `.js` import specifiers (ESM, `verbatimModuleSyntax`); the Expo
  app uses extensionless relative imports (Metro/Babel resolution). Match the package you're in.
- `@medibun/design-tokens` regenerates `src/tokens.generated.ts` and `dist/` on `build`; don't
  hand-edit generated files.
