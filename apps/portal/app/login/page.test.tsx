import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { getSessionProfile, redirect } = vi.hoisted(() => ({
  getSessionProfile: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
}));
vi.mock("../lib/session", () => ({ getSessionProfile }));
vi.mock("next/navigation", () => ({
  redirect,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import LoginPage from "./page";

describe("login page", () => {
  beforeEach(() => {
    getSessionProfile.mockReset();
    redirect.mockClear();
  });

  it("renders the sign-in form for signed-out visitors", async () => {
    getSessionProfile.mockResolvedValue(undefined);
    render(await LoginPage());
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });

  it("redirects already-signed-in visitors to /account", async () => {
    getSessionProfile.mockResolvedValue({ id: "p1", name: "Synthia Loginsmith" });
    await expect(LoginPage()).rejects.toThrow("REDIRECT:/account");
    expect(redirect).toHaveBeenCalledWith("/account");
  });
});
