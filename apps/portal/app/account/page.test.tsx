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

import AccountPage from "./page";

describe("account page", () => {
  beforeEach(() => {
    getSessionProfile.mockReset();
    redirect.mockClear();
  });

  it("redirects signed-out visitors to /login (auth guard)", async () => {
    getSessionProfile.mockResolvedValue(undefined);
    await expect(AccountPage()).rejects.toThrow("REDIRECT:/login");
    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("renders the signed-in patient's profile", async () => {
    getSessionProfile.mockResolvedValue({
      id: "p1",
      name: "Synthia Loginsmith",
      birthDate: "1993-04-12",
    });
    render(await AccountPage());
    expect(screen.getByRole("heading", { name: /Good to see you, Synthia/ })).toBeInTheDocument();
    expect(screen.getByText("Synthia Loginsmith")).toBeInTheDocument();
  });
});
