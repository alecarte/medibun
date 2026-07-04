# @medibun/fhir-types

**Types only.** Re-exports the `@medplum/fhirtypes` types the workspace actually uses, so
FHIR-shaped code can typecheck without any package importing the Medplum SDK graph directly.

Importing this does **not** breach the anti-corruption boundary (there's no runtime, no client,
no session) — but prefer the domain DTOs from `@medibun/api-client` at the app edge; FHIR types
belong in the BFF and `@medibun/medplum-backend`. If you're adding a runtime export here, you're
in the wrong package.
