import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Shape-pins the AccessPolicy templates in infra/medplum/policies (A3 — approved via
 * docs/V0_PROPOSAL.md §5, DATA_MODEL.md access table). These are SECURITY regression
 * tests: a widened grant, a dropped criteria, or an Encounter entry on the front-desk
 * policy must fail CI, not wait for a human to notice.
 */

type PolicyEntry = { resourceType: string; criteria?: string; readonly?: boolean };
type Policy = { resourceType: string; name: string; resource: PolicyEntry[] };

const policiesDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../infra/medplum/policies",
);
const load = (file: string): Policy =>
  JSON.parse(readFileSync(resolve(policiesDir, file), "utf8")) as Policy;

const entryFor = (policy: Policy, type: string): PolicyEntry | undefined =>
  policy.resource.find((r) => r.resourceType === type);

describe("staff-front-desk-v1", () => {
  const policy = load("staff-front-desk.json");

  it("grants NO clinical-record access: no Encounter / Procedure / MedicationAdministration / Media", () => {
    for (const type of ["Encounter", "Procedure", "MedicationAdministration", "Media", "Binary"]) {
      expect(entryFor(policy, type), `${type} must be absent (default-deny)`).toBeUndefined();
    }
  });

  it("org-scopes every PHI resource via %organization compartment criteria", () => {
    for (const type of ["Patient", "Appointment", "Consent", "QuestionnaireResponse"]) {
      expect(entryFor(policy, type)?.criteria).toBe(`${type}?_compartment=%organization`);
    }
  });

  it("keeps operational reads read-only (Schedule/Slot/HealthcareService/Practitioner/Location)", () => {
    for (const type of ["Schedule", "Slot", "HealthcareService", "Practitioner", "Location"]) {
      expect(entryFor(policy, type)?.readonly, `${type} must be readonly`).toBe(true);
    }
  });

  it("keeps Consent and QuestionnaireResponse read-only (accepted table: front desk reads)", () => {
    expect(entryFor(policy, "Consent")?.readonly).toBe(true);
    expect(entryFor(policy, "QuestionnaireResponse")?.readonly).toBe(true);
  });

  it("grants exactly the accepted resource set — nothing extra rides along", () => {
    expect(policy.resource.map((r) => r.resourceType).sort()).toEqual([
      "Appointment",
      "Consent",
      "HealthcareService",
      "Location",
      "Patient",
      "Practitioner",
      "QuestionnaireResponse",
      "Schedule",
      "Slot",
    ]);
  });
});

describe("staff-clinician-v1", () => {
  const policy = load("staff-clinician.json");

  it("keeps Patient demographics read-only (accepted table: clinician reads)", () => {
    const entry = entryFor(policy, "Patient");
    expect(entry?.readonly).toBe(true);
    expect(entry?.criteria).toBe("Patient?_compartment=%organization");
  });

  it("org-scopes every clinical resource via %organization compartment criteria", () => {
    for (const type of [
      "Appointment",
      "Encounter",
      "Procedure",
      "MedicationAdministration",
      "Consent",
      "QuestionnaireResponse",
    ]) {
      expect(entryFor(policy, type)?.criteria).toBe(`${type}?_compartment=%organization`);
      expect(entryFor(policy, type)?.readonly, `${type} is read/write per the table`).not.toBe(
        true,
      );
    }
  });

  it("grants exactly the accepted resource set — Media waits for S7 (photos + consent gate)", () => {
    expect(policy.resource.map((r) => r.resourceType).sort()).toEqual([
      "Appointment",
      "Consent",
      "Encounter",
      "HealthcareService",
      "Location",
      "MedicationAdministration",
      "Patient",
      "Practitioner",
      "Procedure",
      "QuestionnaireResponse",
      "Schedule",
      "Slot",
    ]);
  });
});

describe("bot-check-in-v1", () => {
  const policy = load("bot-check-in.json");

  it("grants only what the Bot does: read Appointments, write Encounters", () => {
    expect(policy.resource.map((r) => r.resourceType).sort()).toEqual(["Appointment", "Encounter"]);
    expect(entryFor(policy, "Appointment")?.readonly).toBe(true);
    expect(entryFor(policy, "Encounter")?.readonly).not.toBe(true);
  });
});

describe("patient-self-v1 (regression: the S2 template stays read-only own-compartment)", () => {
  const policy = load("patient-self.json");

  it("every entry is readonly with non-empty %patient criteria", () => {
    expect(policy.resource.length).toBeGreaterThan(0);
    for (const entry of policy.resource) {
      expect(entry.readonly, `${entry.resourceType} must be readonly`).toBe(true);
      expect(entry.criteria).toContain("%patient");
    }
  });
});
