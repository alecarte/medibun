import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import { Avatar, initials } from "./avatar";

describe("initials", () => {
  it("takes first and last name initials", () => {
    expect(initials("Synthia Loginsmith")).toBe("SL");
    expect(initials("Riley Alexandra Reyes")).toBe("RR");
  });

  it("handles single names and empty strings", () => {
    expect(initials("Synthia")).toBe("S");
    expect(initials("  ")).toBe("?");
  });
});

describe("Avatar", () => {
  it("is deterministic: the same name always renders the same color class", () => {
    const { container: a } = render(<Avatar name="Synthia Loginsmith" />);
    const { container: b } = render(<Avatar name="Synthia Loginsmith" />);
    expect(a.firstElementChild!.className).toBe(b.firstElementChild!.className);
  });

  it("stays out of the accessibility tree (decoration, not content)", () => {
    const { container } = render(<Avatar name="Synthia Loginsmith" />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden");
  });

  it("uses only categorical token classes (no arbitrary colors)", () => {
    const { container } = render(<Avatar name="Synthia Loginsmith" />);
    expect(container.firstElementChild!.className).toMatch(/bg-category-\w+-wash/);
    expect(container.firstElementChild!.className).toMatch(/text-category-\w+-text/);
  });
});
