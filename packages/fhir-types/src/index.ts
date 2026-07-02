/**
 * Shared FHIR / domain types.
 *
 * Types-only package (no runtime). Per the anti-corruption boundary, the apps never
 * talk to Medplum directly — but FHIR-shaped types may be shared where our domain DTOs
 * mirror FHIR resources. Re-exports only the `@medplum/fhirtypes` types we actually use
 * (data minimization applies to the type surface too); prefer domain DTOs at the app edge.
 */

export type {
  Patient,
  HumanName,
  // Booking groundwork (S3): the seed + booking paths in the backend app.
  Identifier,
  Resource,
  Organization,
  Location,
  Slot,
} from "@medplum/fhirtypes";
