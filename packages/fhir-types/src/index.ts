/**
 * Shared FHIR / domain types.
 *
 * Types-only package (no runtime). Per the anti-corruption boundary, the apps never
 * talk to Medplum directly — but FHIR-shaped types may be shared where our domain DTOs
 * mirror FHIR resources. At step 5 (Medplum wiring) this will re-export selected types
 * from `@medplum/fhirtypes`. For now it carries a placeholder so the workspace resolves.
 */

// TODO(step-5): re-export the FHIR resource types we use from `@medplum/fhirtypes`.
export type ResourcePlaceholder = {
  readonly resourceType: string;
  readonly id?: string;
};
