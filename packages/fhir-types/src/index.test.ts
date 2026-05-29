import { describe, it, expectTypeOf } from "vitest";
import type { ResourcePlaceholder } from "./index.js";

describe("fhir-types", () => {
  it("exposes a FHIR-shaped placeholder type", () => {
    expectTypeOf<ResourcePlaceholder>().toHaveProperty("resourceType");
  });
});
