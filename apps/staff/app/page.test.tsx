import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { DaySheet } from "@medibun/api-client";

const { getSessionStaff, getDaySheet, redirect } = vi.hoisted(() => ({
  getSessionStaff: vi.fn(),
  getDaySheet: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
}));
vi.mock("./lib/session", () => ({ getSessionStaff }));
vi.mock("./lib/bff", () => ({
  bffClient: () => ({ getDaySheet }),
  sessionCookie: () => Promise.resolve("medibun_session=x"),
}));
vi.mock("next/navigation", () => ({
  redirect,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import TodayPage from "./page";

const sheet: DaySheet = {
  date: "2026-07-04",
  timezone: "America/New_York",
  practitioners: [{ practitionerId: "pr1", practitionerName: "Riley Reyes" }],
  appointments: [
    {
      id: "a1",
      practitionerId: "pr1",
      patientId: "pt1",
      patientName: "Synthia Loginsmith",
      start: "2026-07-04T18:00:00.000Z",
      end: "2026-07-04T18:30:00.000Z",
      status: "scheduled",
      firstVisit: true,
    },
  ],
};

describe("Today page", () => {
  beforeEach(() => {
    getSessionStaff.mockReset();
    getDaySheet.mockReset();
    redirect.mockClear();
  });

  it("redirects signed-out visitors to /login (auth guard)", async () => {
    getSessionStaff.mockResolvedValue(undefined);
    await expect(TodayPage()).rejects.toThrow("REDIRECT:/login");
  });

  it("renders the day sheet with the practice-local date and count", async () => {
    getSessionStaff.mockResolvedValue({ id: "pr-noor", name: "Noor Haddad" });
    getDaySheet.mockResolvedValue(sheet);
    render(await TodayPage());
    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(screen.getByText(/Saturday, July 4/)).toBeInTheDocument();
    expect(screen.getByText(/1 appointment/)).toBeInTheDocument();
    expect(screen.getByText("Synthia Loginsmith")).toBeInTheDocument();
  });

  it("shows the designed error state when the BFF is unreachable (shell keeps working)", async () => {
    getSessionStaff.mockResolvedValue({ id: "pr-noor", name: "Noor Haddad" });
    getDaySheet.mockRejectedValue(new Error("connect ECONNREFUSED"));
    render(await TodayPage());
    expect(screen.getByText(/The schedule couldn.t load/)).toBeInTheDocument();
  });
});
