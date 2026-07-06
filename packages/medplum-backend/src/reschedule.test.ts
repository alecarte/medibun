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
      "Schedule/s1",
    );
    expect(slots).toEqual(["Slot/sl1", "Slot/sl2"]);
    expect(get).not.toHaveBeenCalled();
  });

  it("falls back to a busy-slot search SCOPED to the appointment's own schedule", async () => {
    const get = vi
      .fn()
      .mockResolvedValue(
        slotBundle([busySlot("sl9", "2026-07-06T18:00:00.000Z", "2026-07-06T18:30:00.000Z")]),
      );
    const slots = await resolveBookedSlots({ get, post: vi.fn() }, booking(), "Schedule/s1");
    expect(slots).toEqual(["Slot/sl9"]);
    const url = get.mock.calls[0]![0] as string;
    expect(url).toContain("fhir/R4/Slot?");
    // The schedule filter is the security control: an unscoped same-window search
    // would claim ANOTHER booking's protector slot as ours (review finding, HIGH).
    expect(url).toContain("schedule=Schedule%2Fs1");
    expect(url).toContain("start=2026-07-06T18%3A00%3A00.000Z");
  });

  it("does NOT fall back without a resolvable own schedule — fails safe, never claims foreign slots", async () => {
    const get = vi.fn();
    const slots = await resolveBookedSlots({ get, post: vi.fn() }, booking(), undefined);
    expect(slots).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it("excludes same-start slots whose end differs (not this booking's window)", async () => {
    const get = vi
      .fn()
      .mockResolvedValue(
        slotBundle([busySlot("sl-longer", "2026-07-06T18:00:00.000Z", "2026-07-06T19:30:00.000Z")]),
      );
    const slots = await resolveBookedSlots({ get, post: vi.fn() }, booking(), "Schedule/s1");
    expect(slots).toEqual([]);
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
    // Overlap query: starts before the window ends AND ends after the window starts,
    // with a ge-bound so a schedule's history can't push a live conflict past the
    // page cap (review finding, MEDIUM). 25h = the longest block we mint (DST all-day).
    expect(url).toContain("schedule=Schedule%2Fs1");
    expect(url).toContain("start=lt2026-07-06T19%3A30%3A00.000Z");
    expect(url).toContain("start=ge2026-07-05T18%3A00%3A00.000Z");
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
