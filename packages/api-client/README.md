# @medibun/api-client

The typed client for **our backend (the BFF)** — the only way product apps (portal, staff,
patient-mobile) talk to the server side. This is the anti-corruption boundary made concrete: it
speaks domain DTOs (`PatientProfile`, `ServiceSummary`, `ServiceAvailability`, …), never FHIR
resources, and never a Medplum URL.

- Wire contract: [`docs/API.md`](../../docs/API.md). The contract tests here are the arbiter
  when code and doc drift.
- Sessions: HttpOnly cookie (web, forwarded explicitly from RSC) or bearer token (mobile) via
  the `SessionAuth` parameter. `SESSION_COOKIE_NAME` is the one shared constant with the BFF.
- Errors: typed `LoginError` / `BookingError` with the BFF's stable PHI-free codes; anything
  unrecognized degrades to `"unknown"`.

Zero runtime dependencies (design-tokens is a type-only import). Adding an endpoint means:
type + method + contract test here, route + test in `apps/api`, and a `docs/API.md` entry —
same PR.
