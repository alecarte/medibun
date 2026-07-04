import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ServiceAvailability, ServiceSummary } from "@medibun/api-client";
import { BookingFlow } from "./booking-flow";
import { stubFetch } from "../../lib/stub-fetch";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));

// jsdom has no object-URL support; capture the Blob so tests can read the .ics payload.
const createdBlobs: Blob[] = [];
beforeEach(() => {
  createdBlobs.length = 0;
  URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => {
    createdBlobs.push(blob as Blob);
    return "blob:mock-ics";
  });
  URL.revokeObjectURL = vi.fn();
});

const service: ServiceSummary = {
  code: "svc-botox",
  name: "Botox",
  description: "Smooths dynamic lines.",
  durationMinutes: 30,
  priceCents: 39_500,
  categoryColor: "sage",
};

// Window starts Monday July 6, 8:00 AM ET; slots sit on Thursday July 9:
// 14:00Z = 10:00 AM ET (morning) and 18:00Z = 2:00 PM ET (afternoon).
const availability: ServiceAvailability = {
  serviceCode: "svc-botox",
  timezone: "America/New_York",
  windowStart: "2026-07-06T12:00:00.000Z",
  windowDays: 7,
  practitioners: [
    {
      scheduleId: "sched-riley",
      practitionerId: "prac-riley",
      practitionerName: "Riley Reyes",
      slots: [
        { start: "2026-07-09T14:00:00.000Z", end: "2026-07-09T14:30:00.000Z" },
        { start: "2026-07-09T18:00:00.000Z", end: "2026-07-09T18:30:00.000Z" },
      ],
    },
    {
      scheduleId: "sched-maya",
      practitionerId: "prac-maya",
      practitionerName: "Maya Chen",
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
    <BookingFlow service={service} availability={overrides.availability ?? availability} />,
  );
}

describe("booking flow", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    refresh.mockClear();
  });

  it("renders every window day with availability in the accessible name, empty days disabled", () => {
    renderFlow();
    // The 7*24h window from Monday 8:00 AM ET touches 8 calendar days.
    const days = screen.getAllByRole("button", { name: /July/ });
    expect(days).toHaveLength(8);
    expect(screen.getByRole("button", { name: "Monday, July 6, no open times" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Thursday, July 9, 2 open times" })).toHaveAttribute(
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

  it("switches practitioners and reveals the newly picked day's times", () => {
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
    expect(screen.getByRole("button", { name: "Book 10:00 AM" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Switch practitioner" }));
    fireEvent.click(screen.getByRole("button", { name: "Maya Chen" }));
    expect(screen.queryByRole("button", { name: "Book 10:00 AM" })).not.toBeInTheDocument();
    // Day switching actually swaps the rendered slots (regression guard).
    fireEvent.click(screen.getByRole("button", { name: "Friday, July 10, 1 open time" }));
    expect(screen.getByRole("button", { name: /Friday, July 10/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "10:00 AM" })).toBeInTheDocument();
    expect(screen.queryByText("Afternoon")).not.toBeInTheDocument();
  });

  it("books optimistically, moves focus to the outcome, and lands the pre-arrival ritual", async () => {
    const calls = stubFetch(201, booked);
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
    fireEvent.click(screen.getByRole("button", { name: "Book 10:00 AM" }));
    // Optimistic: the outcome renders immediately, with an honest settling line.
    expect(screen.getByText(/Booked for/)).toBeInTheDocument();
    expect(screen.getByText("Saving to your record…")).toBeInTheDocument();
    expect(await screen.findByText("It's on the studio's schedule.")).toBeInTheDocument();
    const heading = screen.getByRole("heading", {
      name: /Booked for Thursday, July 9 at 10:00 AM/,
    });
    // Focus lands on the outcome so it is announced (a11y review fix).
    expect(heading).toHaveFocus();
    // The confirmation is the start of the next visit, not a receipt.
    expect(screen.getByText(/Skip alcohol and blood thinners/)).toBeInTheDocument();
    const calendar = screen.getByRole("link", { name: "Add to calendar" });
    expect(calendar).toHaveAttribute("href", "blob:mock-ics");
    // Stable UID regardless of settle timing — re-downloads must not duplicate events.
    const ics = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(createdBlobs[0]!);
    });
    expect(ics).toContain("UID:svc-botox-2026-07-09T14:00:00.000Z@medibun");
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

  it("rolls back calmly when the slot was just taken, hides the dead time, focuses the error", async () => {
    stubFetch(409, { error: "slot_taken", requestId: "r" });
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
    fireEvent.click(screen.getByRole("button", { name: "Book 10:00 AM" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That time was just booked.");
    expect(alert).toHaveFocus();
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
    expect(screen.getByRole("button", { name: /Thursday, July 9/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "10:00 AM" })).toBeInTheDocument();
  });

  it("re-defaults the practitioner when a refresh removes the selected schedule (no dead end)", async () => {
    stubFetch(409, { error: "slot_taken", requestId: "r" });
    const { rerender } = renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
    fireEvent.click(screen.getByRole("button", { name: "Book 10:00 AM" }));
    await screen.findByRole("alert");
    // Fresh availability arrives without Riley's schedule (retired between renders).
    rerender(
      <BookingFlow
        service={service}
        availability={{
          ...availability,
          practitioners: availability.practitioners.filter((p) => p.scheduleId === "sched-maya"),
        }}
      />,
    );
    // The picker re-defaults to Maya instead of dead-ending on "No open times".
    expect(screen.getByText("Maya Chen")).toBeInTheDocument();
    expect(screen.queryByText(/No open times in the next week/)).not.toBeInTheDocument();
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
        ...availability,
        practitioners: [
          {
            scheduleId: "sched-riley",
            practitionerId: "prac-riley",
            practitionerName: "Riley Reyes",
            slots: [],
          },
        ],
      },
    });
    expect(screen.getByText(/No open times in the next week/)).toBeInTheDocument();
  });
});
