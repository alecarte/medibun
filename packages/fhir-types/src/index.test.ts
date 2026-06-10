import { describe, it, expectTypeOf } from "vitest";
import type { Patient, HumanName } from "./index.js";

describe("fhir-types", () => {
  it("re-exports the FHIR Patient type", () => {
    expectTypeOf<Patient>().toHaveProperty("resourceType");
    expectTypeOf<Patient["resourceType"]>().toEqualTypeOf<"Patient">();
  });

  it("re-exports HumanName with given/family parts", () => {
    expectTypeOf<HumanName>().toHaveProperty("given");
    expectTypeOf<HumanName>().toHaveProperty("family");
  });
});
