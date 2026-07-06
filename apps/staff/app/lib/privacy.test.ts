import { describe, it, expect } from "vitest";

import { maskName } from "./privacy";

describe("maskName", () => {
  it("reduces a first + last name to initials", () => {
    expect(maskName("Synthia Loginsmith")).toBe("S. L.");
  });

  it("keeps one initial per name part", () => {
    expect(maskName("Aurelia Vandermeer-Castellanos")).toBe("A. V.");
    expect(maskName("Ana Maria de la Cruz")).toBe("A. M. d. l. C.");
  });

  it("handles a single name", () => {
    expect(maskName("Synthia")).toBe("S.");
  });

  it("never returns an empty mask", () => {
    expect(maskName("")).toBe("•");
    expect(maskName("   ")).toBe("•");
  });
});
