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

// The strip renders the availability DTO's own window, so the fixture is fully
// deterministic — no wall-clock dependence.
const slotStart = new Date("2026-07-09T14:00:00.000Z");
slotStart.setUTCMinutes(0, 0, 0);
const availability = {
  serviceCode: "svc-botox",
  timezone: "America/New_York",
  // The strip renders the DTO's window — anchor it just before the fixture slot.
  windowStart: new Date(slotStart.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(),
  windowDays: 7,
  practitioners: [
    {
      scheduleId: "sched-riley",
      practitionerId: "prac-riley",
      practitionerName: "Riley Reyes",
      slots: [
        {
          start: slotStart.toISOString(),
          end: new Date(slotStart.getTime() + 30 * 60 * 1000).toISOString(),
        },
      ],
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
    // The relative fixture slot renders as a time chip (label depends on the day).
    expect(screen.getByRole("button", { name: /^\d{1,2}:\d{2} (AM|PM)$/ })).toBeInTheDocument();
  });

  it("designs the failure state when availability cannot load", async () => {
    getServices.mockResolvedValue([service]);
    getAvailability.mockResolvedValue(undefined);
    render(await ServiceBookingPage(props));
    expect(screen.getByRole("alert")).toHaveTextContent("We couldn't load open times.");
  });
});
