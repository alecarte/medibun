import { describe, it, expect, vi } from "vitest";

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
}));
vi.mock("next/navigation", () => ({ redirect }));

import Home from "./page";

describe("staff home", () => {
  it("lands on the schedule (the / route is reserved for the future Today dashboard)", () => {
    expect(() => Home()).toThrow("REDIRECT:/schedule");
  });
});
