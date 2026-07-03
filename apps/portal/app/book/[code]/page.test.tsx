import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { getSessionProfile, getServices, getAvailability, redirect, notFound } = vi.hoisted(() => ({
  getSessionProfile: vi.fn(),
  getServices: vi.fn(),
  getAvailability: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));
vi.mock("../../lib/session", () => ({ getSessionProfile }));
vi.mock("../../lib/booking", () => ({ getServices, getAvailability }));
vi.mock("next/navigation", () => ({
  redirect,
  notFound,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import ServiceBookingPage from "./page";

const service = {
  code: "svc-botox",
  name: "Botox",
  description: "Smooths dynamic lines.",
  durationMinutes: 30,
  priceCents: 39_500,
  categoryColor: "sage" as const,
};

const availability = {
  serviceCode: "svc-botox",
  practitioners: [
    {
      scheduleId: "sched-riley",
      practitionerId: "prac-riley",
      practitionerName: "Riley Reyes",
      timezone: "America/New_York",
      slots: [{ start: "2026-07-09T14:00:00.000Z", end: "2026-07-09T14:30:00.000Z" }],
    },
  ],
};

const props = { params: Promise.resolve({ code: "svc-botox" }) };

describe("service booking page", () => {
  beforeEach(() => {
    getSessionProfile.mockReset();
    getServices.mockReset();
    getAvailability.mockReset();
    getSessionProfile.mockResolvedValue({ id: "p1", name: "Synthia Loginsmith" });
  });

  it("redirects signed-out visitors to /login (auth guard)", async () => {
    getSessionProfile.mockResolvedValue(undefined);
    await expect(ServiceBookingPage(props)).rejects.toThrow("REDIRECT:/login");
  });

  it("404s an unknown service code", async () => {
    getServices.mockResolvedValue([service]);
    getAvailability.mockResolvedValue("not_found");
    await expect(ServiceBookingPage(props)).rejects.toThrow("NOT_FOUND");
  });

  it("renders the service header and the slot picker", async () => {
    getServices.mockResolvedValue([service]);
    getAvailability.mockResolvedValue(availability);
    render(await ServiceBookingPage(props));
    expect(screen.getByRole("heading", { name: "Botox" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /All services/ })).toHaveAttribute("href", "/book");
    expect(screen.getByRole("button", { name: "10:00 AM" })).toBeInTheDocument();
  });

  it("designs the failure state when availability cannot load", async () => {
    getServices.mockResolvedValue([service]);
    getAvailability.mockResolvedValue(undefined);
    render(await ServiceBookingPage(props));
    expect(screen.getByRole("alert")).toHaveTextContent("We couldn't load open times.");
  });
});
