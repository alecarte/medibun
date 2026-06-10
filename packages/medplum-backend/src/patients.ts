import { OperationOutcomeError, isNotFound } from "@medplum/core";
import type { Patient } from "@medplum/fhirtypes";

/** The slice of MedplumClient this module needs (injectable for tests). */
export type PatientReader = {
  readResource: (resourceType: "Patient", id: string) => Promise<Patient>;
};

/** Read a Patient by id. Resolves undefined when Medplum reports not-found. */
export async function readPatientById(
  client: PatientReader,
  id: string,
): Promise<Patient | undefined> {
  try {
    return await client.readResource("Patient", id);
  } catch (err) {
    if (err instanceof OperationOutcomeError && isNotFound(err.outcome)) {
      return undefined;
    }
    throw err;
  }
}
