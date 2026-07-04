import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { getSessionStaff, redirect } = vi.hoisted(() => ({
  getSessionStaff: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
}));
vi.mock("../lib/session", () => ({ getSessionStaff }));
vi.mock("next/navigation", () => ({
  redirect,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import LoginPage from "./page";

describe("staff login page", () => {
  beforeEach(() => {
    getSessionStaff.mockReset();
    redirect.mockClear();
  });

  it("sends already-signed-in staff straight to the day sheet", async () => {
    getSessionStaff.mockResolvedValue({ id: "pr1", name: "Noor Haddad" });
    await expect(LoginPage()).rejects.toThrow("REDIRECT:/");
  });

  it("renders the sign-in form for signed-out visitors", async () => {
    getSessionStaff.mockResolvedValue(undefined);
    render(await LoginPage());
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });
});
