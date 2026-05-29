# Testing rules

Binding. Operationalizes the definition of done in `CLAUDE.md`.

## Test-first

- Turn each task into a verifiable goal: write the failing test first, then satisfy it.
- New behavior has tests. Bugfixes get a regression test that fails before the fix.

## Two runners by design

- **Web + shared packages** → Vitest + React Testing Library (`environment: jsdom` for components,
  `node` for packages). Root `vitest.config.ts` uses inline `projects`.
- **Mobile (`patient-mobile`)** → `jest-expo` + `@testing-library/react-native`. Vitest cannot
  reliably test Expo/RN. Do not try to force one runner across the whole repo.
- Turborepo runs each package's own `test` script (`pnpm test`).

## What "tested" means here

- Pure logic: unit tests.
- Components/screens: render + assert behavior (a smoke test at minimum for new surfaces).
- Cross-package contracts (e.g. design-tokens output shape): assert the contract.
- PHI/auth/AccessPolicy behavior: tests are required, and the `security-reviewer` subagent runs
  before the change is done.

## Test data

- Synthetic, non-PHI only. No real SSN/MRN/DOB/patient identifiers in fixtures (the pre-edit hook
  blocks the obvious shapes). See `security.md`.

## Definition of done (testing portion)

`pnpm typecheck` + `pnpm lint` + `pnpm test` pass; new behavior has tests; no secrets/PHI in the
diff, logs, or fixtures; access policy reviewed for any new PHI-touching endpoint; security-reviewer
has run on any PHI/auth/AccessPolicy change.
