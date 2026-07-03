import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { getSessionProfile, getServices, redirect } = vi.hoisted(() => ({
  getSessionProfile: vi.fn(),
  getServices: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
}));
vi.mock("../lib/session", () => ({ getSessionProfile }));
vi.mock("../lib/booking", () => ({ getServices }));
vi.mock("next/navigation", () => ({ redirect }));

import BookPage from "./page";

const services = [
  {
    code: "svc-botox",
    name: "Botox",
    description: "Smooths dynamic lines.",
    durationMinutes: 30,
    priceCents: 39_500,
    categoryColor: "sage" as const,
  },
  {
    code: "svc-lip-filler",
    name: "Lip filler",
    description: "Shape and volume, kept subtle.",
    durationMinutes: 45,
    priceCents: 68_000,
    categoryColor: "plum" as const,
  },
];

describe("booking discovery page", () => {
  beforeEach(() => {
    getSessionProfile.mockReset();
    getServices.mockReset();
    getSessionProfile.mockResolvedValue({ id: "p1", name: "Synthia Loginsmith" });
  });

  it("redirects signed-out visitors to /login (auth guard)", async () => {
    getSessionProfile.mockResolvedValue(undefined);
    await expect(BookPage()).rejects.toThrow("REDIRECT:/login");
  });

  it("renders each bookable service as a link into its availability", async () => {
    getServices.mockResolvedValue(services);
    render(await BookPage());
    const botox = screen.getByRole("link", { name: /Botox/ });
    expect(botox).toHaveAttribute("href", "/book/svc-botox");
    expect(botox).toHaveTextContent("30 min · $395");
    expect(screen.getByRole("link", { name: /Lip filler/ })).toHaveAttribute(
      "href",
      "/book/svc-lip-filler",
    );
  });

  it("designs the failure state instead of crashing", async () => {
    getServices.mockResolvedValue(undefined);
    render(await BookPage());
    expect(screen.getByRole("alert")).toHaveTextContent("We couldn't load the service menu.");
  });

  it("designs the empty state", async () => {
    getServices.mockResolvedValue([]);
    render(await BookPage());
    expect(screen.getByText(/Nothing is bookable online yet/)).toBeInTheDocument();
  });
});
