import type { Appointment, Slot } from "@medplum/fhirtypes";
import { describe, expect, it, vi } from "vitest";

import { resolveBookedSlots, windowIsFree } from "./reschedule.js";

const booking = (overrides?: Partial<Appointment>): Appointment => ({
  resourceType: "Appointment",
  id: "a1",
  status: "booked",
  start: "2026-07-06T18:00:00.000Z",
  end: "2026-07-06T18:30:00.000Z",
  participant: [
    { actor: { reference: "Patient/pt1" }, status: "accepted" },
    { actor: { reference: "Practitioner/pr1" }, status: "accepted" },
  ],
  ...overrides,
});

const slotBundle = (slots: Slot[]) => ({
  resourceType: "Bundle",
  type: "searchset",
  entry: slots.map((resource) => ({ resource })),
});

const busySlot = (id: string, start: string, end: string): Slot => ({
  resourceType: "Slot",
  id,
  schedule: { reference: "Schedule/s1" },
  status: "busy",
  start,
  end,
});

describe("resolveBookedSlots", () => {
  it("prefers the appointment's own slot references", async () => {
    const get = vi.fn();
    const slots = await resolveBookedSlots(
      { get, post: vi.fn() },
      booking({ slot: [{ reference: "Slot/sl1" }, { reference: "Slot/sl2" }] }),
    );
    expect(slots).toEqual(["Slot/sl1", "Slot/sl2"]);
    expect(get).not.toHaveBeenCalled();
  });

  it("falls back to a busy-slot search on the appointment's exact window", async () => {
    const get = vi
      .fn()
      .mockResolvedValue(
        slotBundle([busySlot("sl9", "2026-07-06T18:00:00.000Z", "2026-07-06T18:30:00.000Z")]),
      );
    const slots = await resolveBookedSlots({ get, post: vi.fn() }, booking());
    expect(slots).toEqual(["Slot/sl9"]);
    const url = get.mock.calls[0]![0] as string;
    expect(url).toContain("fhir/R4/Slot?");
    expect(url).toContain("start=2026-07-06T18%3A00%3A00.000Z");
  });
});

describe("windowIsFree", () => {
  const window = { start: "2026-07-06T19:00:00.000Z", end: "2026-07-06T19:30:00.000Z" };

  it("is free when no busy slot overlaps on the target schedule", async () => {
    const get = vi.fn().mockResolvedValue(slotBundle([]));
    await expect(windowIsFree({ get, post: vi.fn() }, "Schedule/s1", window, [])).resolves.toBe(
      true,
    );
    const url = get.mock.calls[0]![0] as string;
    // Overlap query: starts before the window ends AND ends after the window starts.
    expect(url).toContain("schedule=Schedule%2Fs1");
    expect(url).toContain("start=lt2026-07-06T19%3A30%3A00.000Z");
  });

  it("is taken when a busy slot overlaps", async () => {
    const get = vi
      .fn()
      .mockResolvedValue(
        slotBundle([busySlot("sl2", "2026-07-06T19:15:00.000Z", "2026-07-06T19:45:00.000Z")]),
      );
    await expect(windowIsFree({ get, post: vi.fn() }, "Schedule/s1", window, [])).resolves.toBe(
      false,
    );
  });

  it("ignores the moving appointment's own slots (a shift within itself is legal)", async () => {
    const get = vi
      .fn()
      .mockResolvedValue(
        slotBundle([busySlot("sl-own", "2026-07-06T19:00:00.000Z", "2026-07-06T19:30:00.000Z")]),
      );
    await expect(
      windowIsFree({ get, post: vi.fn() }, "Schedule/s1", window, ["Slot/sl-own"]),
    ).resolves.toBe(true);
  });

  it("treats free/cancelled slots as non-blocking", async () => {
    const free: Slot = {
      ...busySlot("sl3", "2026-07-06T19:00:00.000Z", "2026-07-06T19:30:00.000Z"),
      status: "free",
    };
    const get = vi.fn().mockResolvedValue(slotBundle([free]));
    await expect(windowIsFree({ get, post: vi.fn() }, "Schedule/s1", window, [])).resolves.toBe(
      true,
    );
  });
});
