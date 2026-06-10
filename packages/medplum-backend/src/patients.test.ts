import { OperationOutcomeError, notFound } from "@medplum/core";
import type { Patient } from "@medplum/fhirtypes";
import { describe, expect, it } from "vitest";

import { readPatientById, type PatientReader } from "./patients.js";

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
});
