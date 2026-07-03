import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ServiceAvailability, ServiceSummary } from "@medibun/api-client";
import { BookingFlow } from "./booking-flow";

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

// 14:00Z on 2026-07-09 = 10:00 AM America/New_York (the practice timezone).
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
        { start: "2026-07-09T15:00:00.000Z", end: "2026-07-09T15:30:00.000Z" },
      ],
    },
    {
      scheduleId: "sched-maya",
      practitionerId: "prac-maya",
      practitionerName: "Maya Chen",
      timezone: "America/New_York",
      slots: [{ start: "2026-07-10T14:00:00.000Z", end: "2026-07-10T14:30:00.000Z" }],
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

function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  return calls;
}

describe("booking flow", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    refresh.mockClear();
  });

  it("groups the selected practitioner's slots by practice-timezone day", () => {
    render(<BookingFlow service={service} availability={availability} />);
    expect(screen.getByRole("heading", { name: "Thursday, July 9" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "10:00 AM" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "11:00 AM" })).toBeInTheDocument();
  });

  it("switches practitioners and clears the selection", () => {
    render(<BookingFlow service={service} availability={availability} />);
    fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
    expect(screen.getByRole("button", { name: "Book 10:00 AM" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Maya Chen" }));
    expect(screen.queryByRole("button", { name: "Book 10:00 AM" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Friday, July 10" })).toBeInTheDocument();
  });

  it("books optimistically: the confirmation states the outcome before the server settles", async () => {
    const calls = stubFetch(201, booked);
    render(<BookingFlow service={service} availability={availability} />);
    fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
    fireEvent.click(screen.getByRole("button", { name: "Book 10:00 AM" }));
    // Optimistic: the outcome renders immediately, with an honest settling line.
    expect(screen.getByText(/Booked for/)).toBeInTheDocument();
    expect(screen.getByText("Saving to your record…")).toBeInTheDocument();
    expect(await screen.findByText("It's on the studio's schedule.")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Booked for Thursday, July 9 at 10:00 AM/ }),
    ).toBeInTheDocument();
    expect(calls[0]!.url).toBe("/api/appointments");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      serviceCode: "svc-botox",
      scheduleId: "sched-riley",
      start: "2026-07-09T14:00:00.000Z",
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("rolls back calmly when the slot was just taken, and hides the dead time", async () => {
    stubFetch(409, { error: "slot_taken", requestId: "r" });
    render(<BookingFlow service={service} availability={availability} />);
    fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
    fireEvent.click(screen.getByRole("button", { name: "Book 10:00 AM" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That time was just booked.");
    // Back on the picker, with the taken slot hidden and others still offered.
    expect(screen.queryByRole("button", { name: "10:00 AM" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "11:00 AM" })).toBeInTheDocument();
  });

  it("keeps the failure copy calm and unblaming on unknown errors", async () => {
    stubFetch(500, { error: "internal_error", requestId: "r" });
    render(<BookingFlow service={service} availability={availability} />);
    fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
    fireEvent.click(screen.getByRole("button", { name: "Book 10:00 AM" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your visit wasn't booked — try again.");
    // Nothing was lost: the slot is still offered.
    expect(screen.getByRole("button", { name: "10:00 AM" })).toBeInTheDocument();
  });

  it("designs the empty state: no open times, stated plainly", () => {
    render(
      <BookingFlow
        service={service}
        availability={{
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
        }}
      />,
    );
    expect(screen.getByText(/No open times in the next week/)).toBeInTheDocument();
  });
});
