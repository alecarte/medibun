import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import type { DaySheet } from "@medibun/api-client";

import { ScheduleView } from "./day-sheet";
import { IDLE_MASK_MS, POLL_INTERVAL_MS } from "../lib/privacy";
import { stubFetch } from "../lib/stub-fetch";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

/** Day sheet: two practitioner columns, workflow states represented (testing rules). */
const daySheet: DaySheet = {
  date: "2026-07-06",
  days: 1,
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
      start: "2026-07-06T18:00:00.000Z", // 2:00 PM EDT
      end: "2026-07-06T18:30:00.000Z",
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
      start: "2026-07-06T19:00:00.000Z",
      end: "2026-07-06T19:45:00.000Z",
      status: "arrived",
      firstVisit: false,
    },
  ],
  events: [],
};

/** Week sheet: Mon-anchored, one practitioner with two appts on different days. */
const weekSheet: DaySheet = {
  date: "2026-07-06", // Monday
  days: 7,
  timezone: "America/New_York",
  practitioners: [
    { practitionerId: "pr1", practitionerName: "Riley Reyes" },
    { practitionerId: "pr2", practitionerName: "Maya Chen" },
  ],
  appointments: [
    { ...daySheet.appointments[0]! }, // Mon
    {
      ...daySheet.appointments[0]!,
      id: "a3",
      patientName: "Jo Park",
      start: "2026-07-08T15:00:00.000Z", // Wed 11:00 EDT
      end: "2026-07-08T15:30:00.000Z",
    },
    {
      ...daySheet.appointments[1]!,
      id: "a4",
      practitionerId: "pr2",
      patientName: "Priya Raghunathan",
      start: "2026-07-07T16:00:00.000Z", // Tue, other practitioner
      end: "2026-07-07T16:45:00.000Z",
    },
  ],
  events: [],
};

const dayProps = { sheet: daySheet, view: "day" as const };

describe("ScheduleView — day view", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    push.mockClear();
    refresh.mockClear();
  });

  it("renders one column per practitioner with every appointment visible", () => {
    stubFetch(200, {});
    render(<ScheduleView {...dayProps} />);
    expect(screen.getByText("Riley Reyes")).toBeInTheDocument();
    expect(screen.getByText("Maya Chen")).toBeInTheDocument();
    expect(screen.getByText("Synthia Loginsmith")).toBeInTheDocument();
    expect(screen.getByText("Aurelia Vandermeer-Castellanos")).toBeInTheDocument();
  });

  it("shows times, service, chips, count, and the New marker", () => {
    stubFetch(200, {});
    render(<ScheduleView {...dayProps} />);
    expect(screen.getByText("2:00 PM–2:30 PM")).toBeInTheDocument();
    expect(screen.getByText("Botox")).toBeInTheDocument();
    expect(screen.getByText("Scheduled")).toBeInTheDocument();
    expect(screen.getByText("Arrived")).toBeInTheDocument();
    // Scoped to the column: the toolbar's "New" (event) button also says New.
    const column = screen.getByRole("list", { name: "Riley Reyes appointments" });
    expect(within(column).getByText("New")).toBeInTheDocument();
    expect(screen.getByText("2 appointments")).toBeInTheDocument();
  });

  it("shows the day empty state when there are no appointments", () => {
    stubFetch(200, {});
    render(<ScheduleView sheet={{ ...daySheet, appointments: [] }} view="day" />);
    expect(screen.getByText("No appointments on this day.")).toBeInTheDocument();
    expect(screen.getByText("Riley Reyes")).toBeInTheDocument(); // columns still render
  });

  it("checks in with one tap: optimistic chip, POST, undo toast", async () => {
    const calls = stubFetch(200, { id: "a1", status: "arrived" });
    render(<ScheduleView {...dayProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Check in Synthia Loginsmith" }));
    expect(screen.getAllByText("Arrived")).toHaveLength(2);
    expect(await screen.findByText(/Checked in — Synthia Loginsmith/)).toBeInTheDocument();
    expect(calls[0]!.url).toBe("/api/staff/appointments/a1/status");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ status: "arrived" });
  });

  it("undo reverses the check-in with a compensating write", async () => {
    const calls = stubFetch(200, { id: "a1", status: "arrived" });
    render(<ScheduleView {...dayProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Check in Synthia Loginsmith" }));
    fireEvent.click(await screen.findByRole("button", { name: /Undo/ }));
    expect(await screen.findByText("Scheduled")).toBeInTheDocument();
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ status: "scheduled" });
  });

  it("reverts and explains when the write fails", async () => {
    stubFetch(500, { error: "internal_error", requestId: "r" });
    render(<ScheduleView {...dayProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Check in Synthia Loginsmith" }));
    expect(await screen.findByText("Couldn't update the appointment. Try again.")).toBeVisible();
    expect(screen.getByText("Scheduled")).toBeInTheDocument();
  });

  it("refreshes on a cross-station conflict instead of clobbering", async () => {
    stubFetch(409, { error: "conflict", requestId: "r" });
    render(<ScheduleView {...dayProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Check in Synthia Loginsmith" }));
    expect(await screen.findByText(/changed on another station/)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it("opens the detail card with contact info and the status menu", () => {
    stubFetch(200, {});
    render(<ScheduleView {...dayProps} />);
    fireEvent.click(screen.getByText("Synthia Loginsmith"));
    const dialog = screen.getByRole("dialog", { name: /Synthia Loginsmith/ });
    expect(within(dialog).getByText("555-010-0100")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Check in" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Mark no-show" })).toBeInTheDocument();
  });

  it("is keyboard-first: C on a focused scheduled block checks in", async () => {
    const calls = stubFetch(200, { id: "a1", status: "arrived" });
    render(<ScheduleView {...dayProps} />);
    const block = screen.getByText("Synthia Loginsmith").closest("button")!;
    fireEvent.focus(block);
    fireEvent.keyDown(block, { key: "c" });
    await screen.findByText(/Checked in — Synthia Loginsmith/);
    expect(calls).toHaveLength(1);
  });

  it("shows an em dash, never a blank, for missing contact details", () => {
    stubFetch(200, {});
    render(<ScheduleView {...dayProps} />);
    fireEvent.click(screen.getByText("Aurelia Vandermeer-Castellanos"));
    const dialog = screen.getByRole("dialog", { name: /Aurelia/ });
    expect(within(dialog).getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("arrow keys move focus across to the nearest block in the next column", () => {
    stubFetch(200, {});
    render(<ScheduleView {...dayProps} />);
    const first = screen.getByText("Synthia Loginsmith").closest("button")!;
    fireEvent.focus(first);
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(screen.getByText("Aurelia Vandermeer-Castellanos").closest("button")).toHaveFocus();
  });

  it("lays overlapping appointments side by side — neither hides the other (4D fix)", () => {
    stubFetch(200, {});
    const overlapping: DaySheet = {
      ...daySheet,
      appointments: [
        daySheet.appointments[0]!, // 2:00–2:30 PM, pr1
        {
          ...daySheet.appointments[0]!,
          id: "a9",
          patientName: "Noa Feldman-Iwu",
          start: "2026-07-06T18:15:00.000Z", // 2:15 PM — overlaps a1
          end: "2026-07-06T18:45:00.000Z",
        },
      ],
    };
    render(<ScheduleView sheet={overlapping} view="day" />);
    const first = screen.getByText("Synthia Loginsmith").closest('[role="listitem"]')!;
    const second = screen.getByText("Noa Feldman-Iwu").closest('[role="listitem"]')!;
    // Both share the column at half width, in different lanes.
    expect((first as HTMLElement).style.width).toContain("50%");
    expect((second as HTMLElement).style.width).toContain("50%");
    expect((first as HTMLElement).style.left).not.toBe((second as HTMLElement).style.left);
  });

  it("labels each column list and renders its appointments in start order", () => {
    stubFetch(200, {});
    const outOfOrder: DaySheet = {
      ...daySheet,
      appointments: [
        {
          ...daySheet.appointments[0]!,
          id: "late",
          patientName: "Later Patient",
          start: "2026-07-06T20:00:00.000Z",
          end: "2026-07-06T20:30:00.000Z",
        },
        daySheet.appointments[0]!, // 2:00 PM — earlier, but listed second on the wire
      ],
    };
    render(<ScheduleView sheet={outOfOrder} view="day" />);
    const column = screen.getByRole("list", { name: "Riley Reyes appointments" });
    const names = within(column)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(names[0]).toContain("Synthia Loginsmith");
    expect(names[1]).toContain("Later Patient");
  });

  it("undo still lands after navigating away (the toast carries the appointment)", async () => {
    const calls = stubFetch(200, { id: "a1", status: "arrived" });
    const { rerender } = render(<ScheduleView {...dayProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Check in Synthia Loginsmith" }));
    await screen.findByText(/Checked in — Synthia Loginsmith/);
    // Navigate to another day: a fresh sheet without a1 replaces the current one.
    rerender(
      <ScheduleView
        sheet={{ ...daySheet, date: "2026-07-07", appointments: [daySheet.appointments[1]!] }}
        view="day"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe("/api/staff/appointments/a1/status");
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ status: "scheduled" });
  });

  it("resets a stale keyboard cursor when the sheet changes (keyboard must not die)", () => {
    stubFetch(200, {});
    const { rerender } = render(<ScheduleView {...dayProps} />);
    fireEvent.focus(screen.getByText("Synthia Loginsmith").closest("button")!);
    // The new sheet no longer contains the focused appointment.
    rerender(
      <ScheduleView
        sheet={{ ...daySheet, date: "2026-07-07", appointments: [daySheet.appointments[1]!] }}
        view="day"
      />,
    );
    const remaining = screen.getByText("Aurelia Vandermeer-Castellanos").closest("button")!;
    expect(remaining).toHaveAttribute("tabindex", "0");
  });
});

describe("ScheduleView — toolbar navigation", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    push.mockClear();
    stubFetch(200, {});
  });

  it("prev/next/today push the right day URLs", () => {
    render(<ScheduleView {...dayProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    expect(push).toHaveBeenLastCalledWith("/schedule?date=2026-07-05");
    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    expect(push).toHaveBeenLastCalledWith("/schedule?date=2026-07-07");
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(push).toHaveBeenLastCalledWith("/schedule");
  });

  it("[ ] and T keys mirror prev/next/today", () => {
    render(<ScheduleView {...dayProps} />);
    fireEvent.keyDown(window, { key: "]" });
    expect(push).toHaveBeenLastCalledWith("/schedule?date=2026-07-07");
    fireEvent.keyDown(window, { key: "[" });
    expect(push).toHaveBeenLastCalledWith("/schedule?date=2026-07-05");
    fireEvent.keyDown(window, { key: "t" });
    expect(push).toHaveBeenLastCalledWith("/schedule");
  });

  it("the view dropdown and W key switch to the week (Monday-anchored)", () => {
    render(<ScheduleView {...dayProps} />);
    fireEvent.click(screen.getByRole("button", { name: /^Day/ }));
    fireEvent.click(screen.getByRole("button", { name: /Week/ }));
    // Switching to week carries the default practitioner into the URL (deterministic).
    expect(push).toHaveBeenLastCalledWith("/schedule?view=week&date=2026-07-06&practitioner=pr1");
    push.mockClear();
    fireEvent.keyDown(window, { key: "w" });
    expect(push).toHaveBeenLastCalledWith("/schedule?view=week&date=2026-07-06&practitioner=pr1");
  });

  it("lists Month as Soon, never as a working option", () => {
    render(<ScheduleView {...dayProps} />);
    fireEvent.click(screen.getByRole("button", { name: /^Day/ }));
    expect(screen.getByText("Month")).toBeInTheDocument();
    expect(screen.getByText("Soon")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Month/ })).not.toBeInTheDocument();
  });

  it("the date button opens the mini-calendar; picking a day navigates", () => {
    render(<ScheduleView {...dayProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Mon, Jul 6" }));
    expect(screen.getByRole("dialog", { name: "Choose date" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("gridcell", { name: "2026-07-09" }));
    expect(push).toHaveBeenLastCalledWith("/schedule?date=2026-07-09");
  });

  it("the keyboard icon opens the shortcuts popover", () => {
    render(<ScheduleView {...dayProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    expect(screen.getByText("Check in the focused appointment")).toBeInTheDocument();
  });

  it("? opens the shortcuts popover from the keyboard", () => {
    render(<ScheduleView {...dayProps} />);
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("suppresses page shortcuts while a dialog is open (detail card)", () => {
    render(<ScheduleView {...dayProps} />);
    fireEvent.click(screen.getByText("Synthia Loginsmith"));
    expect(screen.getByRole("dialog", { name: /Synthia Loginsmith/ })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "[" });
    fireEvent.keyDown(window, { key: "t" });
    expect(push).not.toHaveBeenCalled();
  });

  it("suppresses page shortcuts while a plain dropdown is open (view switcher)", () => {
    render(<ScheduleView {...dayProps} />);
    fireEvent.click(screen.getByRole("button", { name: /^Day/ }));
    fireEvent.keyDown(window, { key: "w" });
    expect(push).not.toHaveBeenCalled();
  });

  it("Z undoes globally, wherever focus sits", async () => {
    const calls = stubFetch(200, { id: "a1", status: "arrived" });
    render(<ScheduleView {...dayProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Check in Synthia Loginsmith" }));
    await screen.findByText(/Checked in — Synthia Loginsmith/);
    fireEvent.keyDown(window, { key: "z" });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ status: "scheduled" });
  });
});

describe("ScheduleView — week view", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    push.mockClear();
    stubFetch(200, {});
  });

  it("renders 7 weekday columns for the default (self) practitioner", () => {
    render(<ScheduleView sheet={weekSheet} view="week" selfPractitionerId="pr1" />);
    // Mon–Sun headers.
    for (const wd of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
      expect(screen.getByText(wd)).toBeInTheDocument();
    }
    // Riley's two appointments show; Maya's (other practitioner) is filtered out.
    expect(screen.getByText("Synthia Loginsmith")).toBeInTheDocument();
    expect(screen.getByText("Jo Park")).toBeInTheDocument();
    expect(screen.queryByText("Priya Raghunathan")).not.toBeInTheDocument();
    expect(screen.getByText("2 appointments")).toBeInTheDocument();
  });

  it("the practitioner filter switches client-side without a navigation", () => {
    render(<ScheduleView sheet={weekSheet} view="week" selfPractitionerId="pr1" />);
    fireEvent.click(screen.getByRole("button", { name: /Riley Reyes/ }));
    fireEvent.click(screen.getByRole("button", { name: "Maya Chen" }));
    // Now Maya's appointment shows; Riley's are gone — and no router.push fired.
    expect(screen.getByText("Priya Raghunathan")).toBeInTheDocument();
    expect(screen.queryByText("Jo Park")).not.toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("prev/next move by a week", () => {
    render(<ScheduleView sheet={weekSheet} view="week" selfPractitionerId="pr1" />);
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    expect(push).toHaveBeenLastCalledWith("/schedule?view=week&date=2026-07-13&practitioner=pr1");
  });
});

describe("ScheduleView — internal events (S5c)", () => {
  const eventSheet: DaySheet = {
    ...daySheet,
    events: [
      {
        id: "ev1",
        type: "meeting",
        title: "Team huddle",
        practitionerIds: ["pr1", "pr2"],
        start: "2026-07-06T16:00:00.000Z", // 12:00 EDT
        end: "2026-07-06T16:30:00.000Z",
      },
      {
        // Time off is a TITLED BLOCK spanning the practice-local day, not a category
        // (amendment 2026-07-06). isAllDayEvent reads it back as "All day".
        id: "ev2",
        type: "block",
        title: "PTO",
        practitionerIds: ["pr2"],
        start: "2026-07-06T04:00:00.000Z",
        end: "2026-07-07T04:00:00.000Z",
      },
    ],
  };

  beforeEach(() => {
    vi.unstubAllGlobals();
    push.mockClear();
    refresh.mockClear();
  });

  it("renders muted event blocks in every affected practitioner column", () => {
    stubFetch(200, {});
    render(<ScheduleView sheet={eventSheet} view="day" />);
    // The meeting spans both practitioners; the PTO block reads back as All day.
    expect(screen.getAllByText("Team huddle")).toHaveLength(2);
    expect(screen.getByText("PTO")).toBeInTheDocument();
    expect(screen.getByText("All day")).toBeInTheDocument();
    // Events never count as appointments.
    expect(screen.getByText("2 appointments")).toBeInTheDocument();
  });

  it("keeps event titles visible under the privacy mask (non-PHI by rule)", () => {
    stubFetch(200, {});
    render(<ScheduleView sheet={eventSheet} view="day" />);
    fireEvent.keyDown(window, { key: "p" });
    expect(screen.getAllByText("Team huddle")).toHaveLength(2);
    expect(screen.queryByText("Synthia Loginsmith")).not.toBeInTheDocument();
  });

  it("creates an all-day PTO block from the New form and offers undo (compensating delete)", async () => {
    const calls = stubFetch(201, {
      id: "ev9",
      type: "block",
      title: "PTO",
      practitionerIds: ["pr1"],
      start: "2026-07-06T04:00:00.000Z",
      end: "2026-07-07T04:00:00.000Z",
    });
    render(<ScheduleView {...dayProps} />);
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "PTO" } });
    fireEvent.click(screen.getByLabelText("All day"));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText(/PTO added/)).toBeInTheDocument();
    expect(calls[0]!.url).toBe("/api/staff/events");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      type: "block",
      title: "PTO",
      practitionerIds: ["pr1"],
      date: "2026-07-06",
      allDay: true,
    });
    expect(refresh).toHaveBeenCalled();
    // Undo compensates with a DELETE of the created event.
    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    await screen.findByRole("button", { name: "New" }); // settle
    expect(calls[1]!.url).toBe("/api/staff/events/ev9");
    expect(calls[1]!.init?.method).toBe("DELETE");
  });

  it("sends meeting times as practice-local wall times, never instants", async () => {
    const calls = stubFetch(201, {
      id: "ev9",
      type: "meeting",
      title: "Huddle",
      practitionerIds: ["pr1", "pr2"],
      start: "2026-07-06T16:00:00.000Z",
      end: "2026-07-06T16:30:00.000Z",
    });
    render(<ScheduleView {...dayProps} />);
    fireEvent.keyDown(window, { key: "n" }); // N opens the form
    fireEvent.click(screen.getByRole("button", { name: "Meeting" }));
    fireEvent.click(screen.getByRole("button", { name: "Maya Chen" })); // add second
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "12:00" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "12:30" } });
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "Huddle" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await screen.findByText(/Huddle added/);
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      type: "meeting",
      title: "Huddle",
      practitionerIds: ["pr1", "pr2"],
      date: "2026-07-06",
      startTime: "12:00",
      endTime: "12:30",
    });
  });

  it("deletes an event from its detail card; undo recreates it with wall times", async () => {
    const calls = stubFetch(200, { ok: true });
    render(<ScheduleView sheet={eventSheet} view="day" />);
    fireEvent.click(screen.getAllByText("Team huddle")[0]!.closest("button")!);
    const dialog = screen.getByRole("dialog", { name: /Team huddle/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText(/Team huddle removed/)).toBeInTheDocument();
    expect(calls[0]!.url).toBe("/api/staff/events/ev1");
    expect(calls[0]!.init?.method).toBe("DELETE");
    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    await screen.findByRole("button", { name: "New" }); // settle
    expect(calls[1]!.url).toBe("/api/staff/events");
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({
      type: "meeting",
      title: "Team huddle",
      practitionerIds: ["pr1", "pr2"],
      date: "2026-07-06",
      startTime: "12:00",
      endTime: "12:30",
    });
  });

  it("rejects an inverted time range client-side", () => {
    stubFetch(201, {});
    render(<ScheduleView {...dayProps} />);
    fireEvent.keyDown(window, { key: "n" });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "14:00" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "13:00" } });
    expect(screen.getByText("End time must be after the start.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });

  it("filters week-view events to the selected practitioner's days", () => {
    stubFetch(200, {});
    render(
      <ScheduleView
        sheet={{ ...weekSheet, events: eventSheet.events }}
        view="week"
        selfPractitionerId="pr1"
      />,
    );
    // pr1 sees the meeting but not pr2's PTO block.
    expect(screen.getByText("Team huddle")).toBeInTheDocument();
    expect(screen.queryByText("PTO")).not.toBeInTheDocument();
  });
});

describe("ScheduleView — privacy mask", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    push.mockClear();
    refresh.mockClear();
    stubFetch(200, { id: "a1", status: "arrived" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("the toolbar toggle masks patient names to initials; the desk still works", () => {
    render(<ScheduleView {...dayProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Privacy mask" }));
    expect(screen.getByText("S. L.")).toBeInTheDocument();
    expect(screen.getByText("A. V.")).toBeInTheDocument();
    expect(screen.queryByText("Synthia Loginsmith")).not.toBeInTheDocument();
    // Non-PHI context stays: practitioners, services, times, statuses, count.
    expect(screen.getByText("Riley Reyes")).toBeInTheDocument();
    expect(screen.getByText("Botox")).toBeInTheDocument();
    expect(screen.getByText("2 appointments")).toBeInTheDocument();
    // Toggling back restores full names.
    fireEvent.click(screen.getByRole("button", { name: "Privacy mask" }));
    expect(screen.getByText("Synthia Loginsmith")).toBeInTheDocument();
  });

  it("P toggles the mask from the keyboard", () => {
    render(<ScheduleView {...dayProps} />);
    fireEvent.keyDown(window, { key: "p" });
    expect(screen.getByText("S. L.")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "p" });
    expect(screen.getByText("Synthia Loginsmith")).toBeInTheDocument();
  });

  it("P still masks while a panel is open (walk-behind moments don't wait for Esc)", () => {
    render(<ScheduleView {...dayProps} />);
    fireEvent.click(screen.getByText("Synthia Loginsmith"));
    expect(screen.getByRole("dialog", { name: /Synthia Loginsmith/ })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "p" });
    expect(screen.getByRole("dialog", { name: /S\. L\./ })).toBeInTheDocument();
    expect(screen.queryByText("Synthia Loginsmith")).not.toBeInTheDocument();
  });

  it("masks the week view's compact blocks too", () => {
    render(<ScheduleView sheet={weekSheet} view="week" selfPractitionerId="pr1" />);
    fireEvent.keyDown(window, { key: "p" });
    expect(screen.getByText("S. L.")).toBeInTheDocument();
    expect(screen.getByText("J. P.")).toBeInTheDocument();
  });

  it("hides contact details in the detail card while masked", () => {
    render(<ScheduleView {...dayProps} />);
    fireEvent.keyDown(window, { key: "p" });
    fireEvent.click(screen.getByText("S. L."));
    const dialog = screen.getByRole("dialog", { name: /S\. L\./ });
    expect(within(dialog).queryByText("555-010-0100")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("synthia.login@example.test")).not.toBeInTheDocument();
    // Phone, email, and booked-at all read "Hidden" — present but not shown.
    expect(within(dialog).getAllByText("Hidden")).toHaveLength(3);
  });

  it("masks the undo toast and the check-in affordance", async () => {
    render(<ScheduleView {...dayProps} />);
    fireEvent.keyDown(window, { key: "p" });
    fireEvent.click(screen.getByRole("button", { name: "Check in S. L." }));
    expect(await screen.findByText(/Checked in — S\. L\./)).toBeInTheDocument();
    expect(screen.queryByText(/Synthia Loginsmith/)).not.toBeInTheDocument();
  });

  it("auto-engages after the idle window; activity resets the clock", () => {
    vi.useFakeTimers();
    render(<ScheduleView {...dayProps} />);
    // Activity at T+110s: the idle clock restarts, so T+170s is only 60s idle.
    act(() => vi.advanceTimersByTime(IDLE_MASK_MS - 10_000));
    fireEvent.keyDown(window, { key: "Shift" });
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("Synthia Loginsmith")).toBeInTheDocument();
    // Now let it run out for real.
    act(() => vi.advanceTimersByTime(IDLE_MASK_MS + 10_000));
    expect(screen.getByText("S. L.")).toBeInTheDocument();
    // One keypress unmasks — the session was never touched.
    fireEvent.keyDown(window, { key: "p" });
    expect(screen.getByText("Synthia Loginsmith")).toBeInTheDocument();
  });
});

describe("ScheduleView — live updates", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    push.mockClear();
    refresh.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(document, "hidden");
  });

  it("quietly refetches on the poll interval while the tab is visible", () => {
    vi.useFakeTimers();
    stubFetch(200, {});
    render(<ScheduleView {...dayProps} />);
    expect(refresh).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(POLL_INTERVAL_MS));
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(POLL_INTERVAL_MS));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does not poll a hidden tab; catches up when it becomes visible", () => {
    vi.useFakeTimers();
    stubFetch(200, {});
    let hidden = true;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    render(<ScheduleView {...dayProps} />);
    act(() => vi.advanceTimersByTime(POLL_INTERVAL_MS * 3));
    expect(refresh).not.toHaveBeenCalled();
    hidden = false;
    fireEvent(document, new Event("visibilitychange"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("pauses polling while a status write is in flight (no optimistic flicker)", async () => {
    vi.useFakeTimers();
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal("fetch", () => new Promise<Response>((res) => (resolveFetch = res)));
    render(<ScheduleView {...dayProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Check in Synthia Loginsmith" }));
    act(() => vi.advanceTimersByTime(POLL_INTERVAL_MS * 2));
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => {
      resolveFetch(
        new Response(JSON.stringify({ id: "a1", status: "arrived" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    act(() => vi.advanceTimersByTime(POLL_INTERVAL_MS));
    expect(refresh).toHaveBeenCalled();
  });

  it("a background refetch keeps the user's scroll position", () => {
    stubFetch(200, {});
    const { rerender } = render(<ScheduleView {...dayProps} />);
    const scroller = screen.getByTestId("schedule-scroll");
    scroller.scrollTop = 999;
    // Same day, new sheet object — exactly what a background router.refresh delivers.
    rerender(<ScheduleView sheet={{ ...daySheet }} view="day" />);
    expect(scroller.scrollTop).toBe(999);
    // A real navigation (different date) re-runs the auto-scroll.
    rerender(
      <ScheduleView
        sheet={{ ...daySheet, date: "2026-07-07", appointments: [daySheet.appointments[1]!] }}
        view="day"
      />,
    );
    expect(scroller.scrollTop).not.toBe(999);
  });
});
