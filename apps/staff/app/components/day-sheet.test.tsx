import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { DaySheet } from "@medibun/api-client";

import { DaySheetView } from "./day-sheet";
import { stubFetch } from "../lib/stub-fetch";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));

/** Synthetic sheet: two columns, the workflow's states represented (testing rules). */
const sheet: DaySheet = {
  date: "2026-07-04",
  timezone: "America/New_York",
  practitioners: [
    { practitionerId: "pr1", practitionerName: "Riley Reyes" },
    { practitionerId: "pr2", practitionerName: "Maya Chen" },
  ],
  appointments: [
    {
      id: "a1",
      practitionerId: "pr1",
      patientId: "pt1",
      patientName: "Synthia Loginsmith",
      patientPhone: "555-010-0100",
      patientEmail: "synthia.login@example.test",
      serviceCode: "svc-botox",
      serviceName: "Botox",
      serviceColor: "sage",
      start: "2026-07-04T18:00:00.000Z", // 2:00 PM EDT
      end: "2026-07-04T18:30:00.000Z",
      status: "scheduled",
      firstVisit: true,
      bookedAt: "2026-07-01T15:00:00.000Z",
    },
    {
      id: "a2",
      practitionerId: "pr2",
      patientId: "pt2",
      patientName: "Aurelia Vandermeer-Castellanos",
      serviceCode: "svc-lip-filler",
      serviceName: "Lip filler",
      serviceColor: "plum",
      start: "2026-07-04T19:00:00.000Z",
      end: "2026-07-04T19:45:00.000Z",
      status: "arrived",
      firstVisit: false,
    },
  ],
};

describe("DaySheetView", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    refresh.mockClear();
  });

  it("renders one column per practitioner with every appointment visible at once", () => {
    stubFetch(200, {});
    render(<DaySheetView sheet={sheet} />);
    expect(screen.getByText("Riley Reyes")).toBeInTheDocument();
    expect(screen.getByText("Maya Chen")).toBeInTheDocument();
    expect(screen.getByText("Synthia Loginsmith")).toBeInTheDocument();
    expect(screen.getByText("Aurelia Vandermeer-Castellanos")).toBeInTheDocument();
  });

  it("shows practice-local times, service names, status chips, and the New marker", () => {
    stubFetch(200, {});
    render(<DaySheetView sheet={sheet} />);
    expect(screen.getByText("2:00 PM–2:30 PM")).toBeInTheDocument();
    expect(screen.getByText("Botox")).toBeInTheDocument();
    expect(screen.getByText("Scheduled")).toBeInTheDocument();
    expect(screen.getByText("Arrived")).toBeInTheDocument();
    expect(screen.getByText("New")).toBeInTheDocument();
  });

  it("shows the designed empty state when the day has no appointments", () => {
    stubFetch(200, {});
    render(<DaySheetView sheet={{ ...sheet, appointments: [] }} />);
    expect(screen.getByText("No appointments today.")).toBeInTheDocument();
    expect(screen.getByText(/Portal bookings appear here/)).toBeInTheDocument();
    // Columns still render — the sheet's shape is honest even when empty.
    expect(screen.getByText("Riley Reyes")).toBeInTheDocument();
  });

  it("checks in with one tap: optimistic chip, immediate write, undo toast", async () => {
    const calls = stubFetch(200, { id: "a1", status: "arrived" });
    render(<DaySheetView sheet={sheet} />);
    fireEvent.click(screen.getByRole("button", { name: "Check in Synthia Loginsmith" }));
    // Optimistic: the chip flips before the network settles.
    expect(screen.getAllByText("Arrived")).toHaveLength(2);
    const toast = await screen.findByText(/Checked in — Synthia Loginsmith/);
    expect(toast).toBeInTheDocument();
    expect(calls[0]!.url).toBe("/api/staff/appointments/a1/status");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ status: "arrived" });
    expect(screen.getByRole("button", { name: /Undo/ })).toBeInTheDocument();
  });

  it("undo reverses the check-in with a compensating write (undo-over-confirm)", async () => {
    const calls = stubFetch(200, { id: "a1", status: "arrived" });
    render(<DaySheetView sheet={sheet} />);
    fireEvent.click(screen.getByRole("button", { name: "Check in Synthia Loginsmith" }));
    const undoButton = await screen.findByRole("button", { name: /Undo/ });
    fireEvent.click(undoButton);
    expect(await screen.findByText("Scheduled")).toBeInTheDocument();
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ status: "scheduled" });
    // No undo toast for an undo.
    expect(screen.queryByRole("button", { name: /Undo/ })).not.toBeInTheDocument();
  });

  it("reverts the optimistic state and says what happened when the write fails", async () => {
    stubFetch(500, { error: "internal_error", requestId: "r" });
    render(<DaySheetView sheet={sheet} />);
    fireEvent.click(screen.getByRole("button", { name: "Check in Synthia Loginsmith" }));
    expect(await screen.findByText("Couldn't update the appointment. Try again.")).toBeVisible();
    expect(screen.getByText("Scheduled")).toBeInTheDocument();
  });

  it("on a cross-station conflict it refreshes to server truth instead of clobbering", async () => {
    stubFetch(409, { error: "conflict", requestId: "r" });
    render(<DaySheetView sheet={sheet} />);
    fireEvent.click(screen.getByRole("button", { name: "Check in Synthia Loginsmith" }));
    expect(await screen.findByText(/changed on another station/)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it("opens the detail card with contact info, booked time, and the status menu", () => {
    stubFetch(200, {});
    render(<DaySheetView sheet={sheet} />);
    fireEvent.click(screen.getByText("Synthia Loginsmith"));
    const dialog = screen.getByRole("dialog", { name: /Synthia Loginsmith/ });
    expect(within(dialog).getByText("555-010-0100")).toBeInTheDocument();
    expect(within(dialog).getByText("synthia.login@example.test")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Check in" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Mark no-show" })).toBeInTheDocument();
  });

  it("shows an em dash, never a blank, for missing contact details", () => {
    stubFetch(200, {});
    render(<DaySheetView sheet={sheet} />);
    fireEvent.click(screen.getByText("Aurelia Vandermeer-Castellanos"));
    const dialog = screen.getByRole("dialog", { name: /Aurelia/ });
    expect(within(dialog).getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("is keyboard-first: C on a focused scheduled block checks in", async () => {
    const calls = stubFetch(200, { id: "a1", status: "arrived" });
    render(<DaySheetView sheet={sheet} />);
    const block = screen.getByText("Synthia Loginsmith").closest("button")!;
    fireEvent.focus(block);
    fireEvent.keyDown(block, { key: "c" });
    await screen.findByText(/Checked in — Synthia Loginsmith/);
    expect(calls).toHaveLength(1);
  });

  it("arrow keys move focus down a column and across to the nearest block", () => {
    stubFetch(200, {});
    render(<DaySheetView sheet={sheet} />);
    const first = screen.getByText("Synthia Loginsmith").closest("button")!;
    fireEvent.focus(first);
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(screen.getByText("Aurelia Vandermeer-Castellanos").closest("button")).toHaveFocus();
  });
});
