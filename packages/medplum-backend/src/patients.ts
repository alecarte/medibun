import { OperationOutcomeError, getStatus, isNotFound } from "@medplum/core";
import type { Patient } from "@medplum/fhirtypes";

/** The slice of MedplumClient this module needs (injectable for tests). */
export type PatientReader = {
  readResource: (resourceType: "Patient", id: string) => Promise<Patient>;
};

/**
 * Thrown when a read performed AS an end user is rejected by Medplum for an auth
 * reason (401/403) — i.e. the user's access token expired or was revoked upstream
 * between session validation and the read. The BFF maps this to a 401 (re-authenticate),
 * NOT a 500: an expired token is a client auth condition, not a server fault.
 */
export class SessionExpiredError extends Error {
  constructor() {
    super("session expired");
    this.name = "SessionExpiredError";
  }
}

/**
 * Read a Patient by id. Resolves undefined when Medplum reports not-found; throws
 * SessionExpiredError when Medplum rejects the caller's token (401/403).
 */
export async function readPatientById(
  client: PatientReader,
  id: string,
): Promise<Patient | undefined> {
  try {
    return await client.readResource("Patient", id);
  } catch (err) {
    if (err instanceof OperationOutcomeError) {
      if (isNotFound(err.outcome)) {
        return undefined;
      }
      const status = getStatus(err.outcome);
      if (status === 401 || status === 403) {
        throw new SessionExpiredError();
      }
    }
    throw err;
  }
}

/**
 * Read a Patient for a LIST surface that degrades per row (S5.7 move-up): a policy
 * denial (403) reads like not-found — undefined — so one hidden patient neither
 * aborts the whole list nor masquerades as a session expiry. A real 401 still throws
 * SessionExpiredError (the caller's token is dead for every row, not just this one).
 * readPatientById above keeps the strict mapping for single-resource surfaces.
 */
export async function readPatientIfVisible(
  client: PatientReader,
  id: string,
): Promise<Patient | undefined> {
  try {
    return await client.readResource("Patient", id);
  } catch (err) {
    if (err instanceof OperationOutcomeError) {
      const status = getStatus(err.outcome);
      if (isNotFound(err.outcome) || status === 403) {
        return undefined;
      }
      if (status === 401) {
        throw new SessionExpiredError();
      }
    }
    throw err;
  }
}
