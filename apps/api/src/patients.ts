import type { PatientProfile } from "@medibun/api-client";
import type { Patient } from "@medibun/fhir-types";

/**
 * FHIR → domain translation (the anti-corruption boundary's seam). The DTO is
 * deliberately minimal — data minimization applies to what leaves the BFF.
 */
export function toPatientProfile(patient: Patient): PatientProfile {
  if (!patient.id) {
    throw new Error("toPatientProfile: patient resource has no id");
  }
  const name = patient.name?.[0];
  const display = [...(name?.given ?? []), name?.family].filter(Boolean).join(" ");
  return {
    id: patient.id,
    name: display === "" ? "Unknown" : display,
    ...(patient.birthDate !== undefined ? { birthDate: patient.birthDate } : {}),
  };
}
