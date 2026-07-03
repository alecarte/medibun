import type { PatientProfile } from "@medibun/api-client";
import type { HumanName, Patient } from "@medibun/fhir-types";

/**
 * FHIR → domain translation (the anti-corruption boundary's seam). The DTO is
 * deliberately minimal — data minimization applies to what leaves the BFF.
 */

/** The one HumanName → display rule for every DTO (patients, practitioners). */
export function humanNameDisplay(name: HumanName | undefined): string {
  const display = [...(name?.given ?? []), name?.family].filter(Boolean).join(" ");
  return display === "" ? "Unknown" : display;
}

export function toPatientProfile(patient: Patient): PatientProfile {
  if (!patient.id) {
    throw new Error("toPatientProfile: patient resource has no id");
  }
  return {
    id: patient.id,
    name: humanNameDisplay(patient.name?.[0]),
    ...(patient.birthDate !== undefined ? { birthDate: patient.birthDate } : {}),
  };
}
