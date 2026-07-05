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
vi.mock("../lib/session", () => ({ getSessionStaff }));
vi.mock("../lib/bff", () => ({
  bffClient: () => ({ getDaySheet }),
  sessionCookie: () => Promise.resolve("medibun_session=x"),
}));
vi.mock("next/navigation", () => ({
  redirect,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import SchedulePage from "./page";

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

const props = (date?: string) => ({ searchParams: Promise.resolve(date ? { date } : {}) });

describe("Schedule page", () => {
  beforeEach(() => {
    getSessionStaff.mockReset();
    getDaySheet.mockReset();
    redirect.mockClear();
  });

  it("redirects signed-out visitors to /login (auth guard)", async () => {
    getSessionStaff.mockResolvedValue(undefined);
    await expect(SchedulePage(props())).rejects.toThrow("REDIRECT:/login");
  });

  it("renders the sheet with the practice-local date, count, and day switcher", async () => {
    getSessionStaff.mockResolvedValue({ id: "pr-noor", name: "Noor Haddad" });
    getDaySheet.mockResolvedValue(sheet);
    render(await SchedulePage(props()));
    expect(screen.getByRole("heading", { name: "Schedule" })).toBeInTheDocument();
    expect(screen.getByText(/Saturday, July 4/)).toBeInTheDocument();
    expect(screen.getByText(/1 appointment/)).toBeInTheDocument();
    expect(screen.getByText("Synthia Loginsmith")).toBeInTheDocument();
    // Day switching is plain calendar math on the sheet's date.
    expect(screen.getByRole("link", { name: "Previous day" })).toHaveAttribute(
      "href",
      "/schedule?date=2026-07-03",
    );
    expect(screen.getByRole("link", { name: "Next day" })).toHaveAttribute(
      "href",
      "/schedule?date=2026-07-05",
    );
    // No date param = already today: no Today link.
    expect(screen.queryByRole("link", { name: "Today" })).not.toBeInTheDocument();
    expect(getDaySheet).toHaveBeenCalledWith(undefined, { cookie: "medibun_session=x" });
  });

  it("passes a valid ?date through to the BFF and offers the way back to Today", async () => {
    getSessionStaff.mockResolvedValue({ id: "pr-noor", name: "Noor Haddad" });
    getDaySheet.mockResolvedValue({ ...sheet, date: "2026-07-06", appointments: [] });
    render(await SchedulePage(props("2026-07-06")));
    expect(getDaySheet).toHaveBeenCalledWith("2026-07-06", { cookie: "medibun_session=x" });
    expect(screen.getByRole("link", { name: "Today" })).toHaveAttribute("href", "/schedule");
  });

  it("ignores a malformed ?date instead of forwarding it", async () => {
    getSessionStaff.mockResolvedValue({ id: "pr-noor", name: "Noor Haddad" });
    getDaySheet.mockResolvedValue(sheet);
    render(await SchedulePage(props("next-tuesday")));
    expect(getDaySheet).toHaveBeenCalledWith(undefined, { cookie: "medibun_session=x" });
  });

  it("shows the designed error state when the BFF is unreachable (shell keeps working)", async () => {
    getSessionStaff.mockResolvedValue({ id: "pr-noor", name: "Noor Haddad" });
    getDaySheet.mockRejectedValue(new Error("connect ECONNREFUSED"));
    render(await SchedulePage(props()));
    expect(screen.getByText(/The schedule couldn.t load/)).toBeInTheDocument();
  });
});
