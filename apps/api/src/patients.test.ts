import type { Patient } from "@medibun/fhir-types";
import { describe, expect, it } from "vitest";

import { toPatientProfile } from "./patients.js";

function synthPatient(overrides: Partial<Patient> = {}): Patient {
  return {
    resourceType: "Patient",
    id: "synth-1",
    name: [{ given: ["Synth"], family: "Example" }],
    ...overrides,
  };
}

describe("toPatientProfile", () => {
  it("carries the FHIR id and formats given + family into a display name", () => {
    expect(toPatientProfile(synthPatient())).toEqual({ id: "synth-1", name: "Synth Example" });
  });

  it("joins multiple given names", () => {
    const patient = synthPatient({ name: [{ given: ["Synth", "Q"], family: "Example" }] });
    expect(toPatientProfile(patient).name).toBe("Synth Q Example");
  });

  it("falls back to Unknown when no name is present", () => {
    expect(toPatientProfile(synthPatient({ name: undefined })).name).toBe("Unknown");
  });

  it("includes birthDate only when present", () => {
    expect(toPatientProfile(synthPatient({ birthDate: "1990-01-01" })).birthDate).toBe(
      "1990-01-01",
    );
    expect("birthDate" in toPatientProfile(synthPatient())).toBe(false);
  });

  it("throws when the resource has no id", () => {
    expect(() => toPatientProfile(synthPatient({ id: undefined }))).toThrow(/id/);
  });
});
