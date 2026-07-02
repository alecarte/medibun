import { OperationOutcomeError, forbidden, notFound, unauthorized } from "@medplum/core";
import type { Patient } from "@medplum/fhirtypes";
import { describe, expect, it } from "vitest";

import { readPatientById, SessionExpiredError, type PatientReader } from "./patients.js";

const synthPatient: Patient = {
  resourceType: "Patient",
  id: "synth-1",
  name: [{ given: ["Synth"], family: "Example" }],
};

describe("readPatientById", () => {
  it("returns the patient when Medplum resolves it", async () => {
    const client: PatientReader = {
      readResource: () => Promise.resolve(synthPatient),
    };
    await expect(readPatientById(client, "synth-1")).resolves.toEqual(synthPatient);
  });

  it("returns undefined when Medplum reports not-found", async () => {
    const client: PatientReader = {
      readResource: () => Promise.reject(new OperationOutcomeError(notFound)),
    };
    await expect(readPatientById(client, "missing")).resolves.toBeUndefined();
  });

  it("rethrows non-not-found errors", async () => {
    const client: PatientReader = {
      readResource: () => Promise.reject(new Error("connection refused")),
    };
    await expect(readPatientById(client, "synth-1")).rejects.toThrow("connection refused");
  });

  it("throws SessionExpiredError when Medplum rejects the token (401)", async () => {
    const client: PatientReader = {
      readResource: () => Promise.reject(new OperationOutcomeError(unauthorized)),
    };
    await expect(readPatientById(client, "synth-1")).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("throws SessionExpiredError on a forbidden (403) read", async () => {
    const client: PatientReader = {
      readResource: () => Promise.reject(new OperationOutcomeError(forbidden)),
    };
    await expect(readPatientById(client, "synth-1")).rejects.toBeInstanceOf(SessionExpiredError);
  });
});
