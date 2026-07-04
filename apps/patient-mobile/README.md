# @medibun/patient-mobile

The patient mobile app — Expo SDK 55 (New Architecture), Expo Router, **@shopify/restyle** themed
from `@medibun/design-tokens` (not NativeWind). Stubbed in v0; it activates in a later phase.

**Boundary (binding)**: BFF via `@medibun/api-client` with bearer-token sessions — never a
Medplum SDK. No PHI in AsyncStorage, push bodies, or logs.

```bash
pnpm --filter @medibun/patient-mobile dev    # Expo dev server (also started by plain `pnpm dev`)
pnpm --filter @medibun/patient-mobile test   # jest-expo + RTL-native (NOT Vitest — by design)
```

Conventions differ from the web packages: extensionless relative imports (Metro/Babel), jest-expo
runner (see `.claude/rules/testing.md` — two runners by design).
