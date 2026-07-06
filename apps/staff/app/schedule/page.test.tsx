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
  date: "2026-07-06",
  days: 1,
  timezone: "America/New_York",
  practitioners: [{ practitionerId: "pr1", practitionerName: "Riley Reyes" }],
  appointments: [
    {
      id: "a1",
      practitionerId: "pr1",
      patientId: "pt1",
      patientName: "Synthia Loginsmith",
      start: "2026-07-06T18:00:00.000Z",
      end: "2026-07-06T18:30:00.000Z",
      status: "scheduled",
      firstVisit: true,
    },
  ],
  events: [],
};

const props = (params: { view?: string; date?: string; practitioner?: string } = {}) => ({
  searchParams: Promise.resolve(params),
});

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

  it("fetches today's day view by default and renders the sheet", async () => {
    getSessionStaff.mockResolvedValue({ id: "pr-noor", name: "Noor Haddad" });
    getDaySheet.mockResolvedValue(sheet);
    render(await SchedulePage(props()));
    expect(screen.getByRole("heading", { name: "Schedule" })).toBeInTheDocument();
    expect(screen.getByText("Synthia Loginsmith")).toBeInTheDocument();
    expect(getDaySheet).toHaveBeenCalledWith(
      { date: undefined, days: 1 },
      { cookie: "medibun_session=x" },
    );
  });

  it("requests a 7-day range for the week view", async () => {
    getSessionStaff.mockResolvedValue({ id: "pr-noor", name: "Noor Haddad" });
    getDaySheet.mockResolvedValue({ ...sheet, days: 7 });
    render(await SchedulePage(props({ view: "week", date: "2026-07-06" })));
    expect(getDaySheet).toHaveBeenCalledWith(
      { date: "2026-07-06", days: 7 },
      { cookie: "medibun_session=x" },
    );
  });

  it("ignores a malformed ?date instead of forwarding it", async () => {
    getSessionStaff.mockResolvedValue({ id: "pr-noor", name: "Noor Haddad" });
    getDaySheet.mockResolvedValue(sheet);
    render(await SchedulePage(props({ date: "next-tuesday" })));
    expect(getDaySheet).toHaveBeenCalledWith(
      { date: undefined, days: 1 },
      { cookie: "medibun_session=x" },
    );
  });

  it("falls back to today for an impossible calendar ?date — not the outage card", async () => {
    // 2026-02-31 passes a shape regex but isn't a real date; the BFF would 400 it.
    getSessionStaff.mockResolvedValue({ id: "pr-noor", name: "Noor Haddad" });
    getDaySheet.mockResolvedValue(sheet);
    render(await SchedulePage(props({ date: "2026-02-31" })));
    expect(getDaySheet).toHaveBeenCalledWith(
      { date: undefined, days: 1 },
      { cookie: "medibun_session=x" },
    );
    expect(screen.queryByText(/The schedule couldn.t load/)).not.toBeInTheDocument();
    expect(screen.getByText("Synthia Loginsmith")).toBeInTheDocument();
  });

  it("shows the designed error state when the BFF is unreachable", async () => {
    getSessionStaff.mockResolvedValue({ id: "pr-noor", name: "Noor Haddad" });
    getDaySheet.mockRejectedValue(new Error("connect ECONNREFUSED"));
    render(await SchedulePage(props()));
    expect(screen.getByText(/The schedule couldn.t load/)).toBeInTheDocument();
  });
});
