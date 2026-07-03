import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ServiceAvailability, ServiceSummary } from "@medibun/api-client";
import { BookingFlow } from "./booking-flow";
import { stubFetch } from "../../lib/stub-fetch";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));

const service: ServiceSummary = {
  code: "svc-botox",
  name: "Botox",
  description: "Smooths dynamic lines.",
  durationMinutes: 30,
  priceCents: 39_500,
  categoryColor: "sage",
};

// Window starts Monday July 6 (America/New_York). Slots sit on Thursday July 9:
// 14:00Z = 10:00 AM ET (morning) and 18:00Z = 2:00 PM ET (afternoon).
const WINDOW_START = "2026-07-06T12:00:00.000Z";

const availability: ServiceAvailability = {
  serviceCode: "svc-botox",
  practitioners: [
    {
      scheduleId: "sched-riley",
      practitionerId: "prac-riley",
      practitionerName: "Riley Reyes",
      timezone: "America/New_York",
      slots: [
        { start: "2026-07-09T14:00:00.000Z", end: "2026-07-09T14:30:00.000Z" },
        { start: "2026-07-09T18:00:00.000Z", end: "2026-07-09T18:30:00.000Z" },
      ],
    },
    {
      scheduleId: "sched-maya",
      practitionerId: "prac-maya",
      practitionerName: "Maya Chen",
      timezone: "America/New_York",
      // First slot is the SAME instant as Riley's first — the aligned-grid norm.
      slots: [
        { start: "2026-07-09T14:00:00.000Z", end: "2026-07-09T14:30:00.000Z" },
        { start: "2026-07-10T14:00:00.000Z", end: "2026-07-10T14:30:00.000Z" },
      ],
    },
  ],
};

const booked = {
  id: "appt-1",
  serviceCode: "svc-botox",
  serviceName: "Botox",
  practitionerName: "Riley Reyes",
  start: "2026-07-09T14:00:00.000Z",
  end: "2026-07-09T14:30:00.000Z",
};

function renderFlow(overrides: { availability?: ServiceAvailability } = {}) {
  return render(
    <BookingFlow
      service={service}
      availability={overrides.availability ?? availability}
      windowStartIso={WINDOW_START}
    />,
  );
}

describe("booking flow", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    refresh.mockClear();
  });

  it("renders the 7-day strip with empty days disabled and the first open day active", () => {
    renderFlow();
    const days = screen.getAllByRole("button", { name: /July/ });
    expect(days).toHaveLength(7);
    expect(screen.getByRole("button", { name: "Monday, July 6" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Thursday, July 9" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("groups the active day's times by day part in the practice timezone", () => {
    renderFlow();
    expect(screen.getByText("Morning")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "10:00 AM" })).toBeInTheDocument();
    expect(screen.getByText("Afternoon")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2:00 PM" })).toBeInTheDocument();
  });

  it("shows the first-available practitioner and switches via the affordance", () => {
    renderFlow();
    expect(screen.getByText(/first available/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
    expect(screen.getByRole("button", { name: "Book 10:00 AM" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Switch practitioner" }));
    fireEvent.click(screen.getByRole("button", { name: "Maya Chen" }));
    // Selection cleared; Maya's Friday day is now open in the strip too.
    expect(screen.queryByRole("button", { name: "Book 10:00 AM" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Friday, July 10" })).toBeEnabled();
  });

  it("books optimistically and lands the pre-arrival ritual", async () => {
    const calls = stubFetch(201, booked);
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
    fireEvent.click(screen.getByRole("button", { name: "Book 10:00 AM" }));
    // Optimistic: the outcome renders immediately, with an honest settling line.
    expect(screen.getByText(/Booked for/)).toBeInTheDocument();
    expect(screen.getByText("Saving to your record…")).toBeInTheDocument();
    expect(await screen.findByText("It's on the studio's schedule.")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Booked for Thursday, July 9 at 10:00 AM/ }),
    ).toBeInTheDocument();
    // The confirmation is the start of the next visit, not a receipt.
    expect(screen.getByText(/Skip alcohol and blood thinners/)).toBeInTheDocument();
    const calendar = screen.getByRole("link", { name: "Add to calendar" });
    expect(calendar.getAttribute("href")).toMatch(/^data:text\/calendar/);
    expect(decodeURIComponent(calendar.getAttribute("href")!)).toContain("UID:appt-1@medibun");
    expect(calls[0]!.url).toBe("/api/appointments");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      serviceCode: "svc-botox",
      scheduleId: "sched-riley",
      start: "2026-07-09T14:00:00.000Z",
    });
    // No refresh on success: a transient refetch failure must never replace the
    // confirmation with the page's error state.
    expect(refresh).not.toHaveBeenCalled();
  });

  it("rolls back calmly when the slot was just taken, and hides the dead time", async () => {
    stubFetch(409, { error: "slot_taken", requestId: "r" });
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
    fireEvent.click(screen.getByRole("button", { name: "Book 10:00 AM" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That time was just booked.");
    // Back on the picker, with the taken slot hidden and others still offered.
    expect(screen.queryByRole("button", { name: "10:00 AM" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2:00 PM" })).toBeInTheDocument();
    // Fresh availability is pulled so the picker converges on server truth.
    expect(refresh).toHaveBeenCalled();
  });

  it("hides a taken time only for its own practitioner (same-instant slots elsewhere stay)", async () => {
    stubFetch(409, { error: "slot_taken", requestId: "r" });
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
    fireEvent.click(screen.getByRole("button", { name: "Book 10:00 AM" }));
    await screen.findByRole("alert");
    // Riley's Thursday 10:00 AM is dead — Maya's Thursday 10:00 AM must survive.
    fireEvent.click(screen.getByRole("button", { name: "Switch practitioner" }));
    fireEvent.click(screen.getByRole("button", { name: "Maya Chen" }));
    expect(screen.getByRole("button", { name: "Thursday, July 9" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "10:00 AM" })).toBeInTheDocument();
  });

  it("treats a no-longer-offered time as gone: specific copy, hidden slot, refresh", async () => {
    stubFetch(400, { error: "invalid_request", requestId: "r" });
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
    fireEvent.click(screen.getByRole("button", { name: "Book 10:00 AM" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That time is no longer offered. Pick a current one.");
    expect(screen.queryByRole("button", { name: "10:00 AM" })).not.toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it("keeps the failure copy calm and unblaming on unknown errors", async () => {
    stubFetch(500, { error: "internal_error", requestId: "r" });
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
    fireEvent.click(screen.getByRole("button", { name: "Book 10:00 AM" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your visit wasn't booked — try again.");
    // Nothing was lost: the slot is still offered.
    expect(screen.getByRole("button", { name: "10:00 AM" })).toBeInTheDocument();
  });

  it("designs the empty state: no open times, stated plainly", () => {
    renderFlow({
      availability: {
        serviceCode: "svc-botox",
        practitioners: [
          {
            scheduleId: "sched-riley",
            practitionerId: "prac-riley",
            practitionerName: "Riley Reyes",
            timezone: "America/New_York",
            slots: [],
          },
        ],
      },
    });
    expect(screen.getByText(/No open times in the next week/)).toBeInTheDocument();
  });
});
