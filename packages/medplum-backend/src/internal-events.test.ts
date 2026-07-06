import { notFound, OperationOutcomeError } from "@medplum/core";
import type { Appointment, Resource, Slot } from "@medplum/fhirtypes";
import { describe, expect, it } from "vitest";

import {
  createInternalEvent,
  deleteInternalEvent,
  internalEventCode,
  INTERNAL_EVENTS_CODE_SYSTEM,
  isInternalEvent,
  NotAnInternalEventError,
} from "./internal-events.js";

const eventAppointment = (overrides?: Partial<Appointment>): Appointment => ({
  resourceType: "Appointment",
  id: "ev1",
  status: "booked",
  appointmentType: { coding: [{ system: INTERNAL_EVENTS_CODE_SYSTEM, code: "meeting" }] },
  description: "Team huddle",
  start: "2026-07-06T16:00:00.000Z",
  end: "2026-07-06T16:30:00.000Z",
  slot: [{ reference: "Slot/sl1" }, { reference: "Slot/sl2" }],
  participant: [
    { actor: { reference: "Practitioner/pr1" }, status: "accepted" },
    { actor: { reference: "Practitioner/pr2" }, status: "accepted" },
  ],
  ...overrides,
});

/** Fake writer: records creates/deletes, mints ids. */
function fakeWriter(opts?: { failAppointmentCreate?: boolean; failSlotDelete?: string }) {
  let nextSlot = 0;
  const created: Resource[] = [];
  const deleted: string[] = [];
  return {
    created,
    deleted,
    async createResource<T extends Resource>(resource: T): Promise<T> {
      if (resource.resourceType === "Appointment" && opts?.failAppointmentCreate) {
        throw new Error("appointment create failed");
      }
      const withId = {
        ...resource,
        id: resource.resourceType === "Slot" ? `sl${++nextSlot}` : "ev1",
      };
      created.push(withId);
      return withId as T;
    },
    async deleteResource(resourceType: "Appointment" | "Slot", id: string): Promise<unknown> {
      if (opts?.failSlotDelete === id) {
        throw new OperationOutcomeError(notFound);
      }
      deleted.push(`${resourceType}/${id}`);
      return undefined;
    },
  };
}

describe("createInternalEvent", () => {
  it("creates one busy-unavailable slot per schedule, then the patient-less appointment carrying the slot refs", async () => {
    const writer = fakeWriter();
    const appointment = await createInternalEvent(writer, {
      code: "meeting",
      title: "Team huddle",
      practitionerReferences: ["Practitioner/pr1", "Practitioner/pr2"],
      scheduleReferences: ["Schedule/s1", "Schedule/s2", "Schedule/s3"],
      start: "2026-07-06T16:00:00.000Z",
      end: "2026-07-06T16:30:00.000Z",
    });
    const slots = writer.created.filter((r): r is Slot => r.resourceType === "Slot");
    expect(slots).toHaveLength(3);
    for (const slot of slots) {
      expect(slot.status).toBe("busy-unavailable");
      expect(slot.start).toBe("2026-07-06T16:00:00.000Z");
    }
    expect(slots.map((s) => s.schedule.reference)).toEqual([
      "Schedule/s1",
      "Schedule/s2",
      "Schedule/s3",
    ]);
    expect(appointment.slot).toEqual([
      { reference: "Slot/sl1" },
      { reference: "Slot/sl2" },
      { reference: "Slot/sl3" },
    ]);
    expect(appointment.description).toBe("Team huddle");
    expect(internalEventCode(appointment)).toBe("meeting");
    // No patient participates — the day sheet must never mistake this for a booking.
    expect(appointment.participant?.every((p) => !p.actor?.reference?.startsWith("Patient/"))).toBe(
      true,
    );
  });

  it("compensates on appointment failure: created slots are deleted, error rethrown", async () => {
    const writer = fakeWriter({ failAppointmentCreate: true });
    await expect(
      createInternalEvent(writer, {
        code: "day-off",
        practitionerReferences: ["Practitioner/pr1"],
        scheduleReferences: ["Schedule/s1", "Schedule/s2"],
        start: "2026-07-07T04:00:00.000Z",
        end: "2026-07-08T04:00:00.000Z",
      }),
    ).rejects.toThrow("appointment create failed");
    expect(writer.deleted).toEqual(["Slot/sl1", "Slot/sl2"]);
  });

  it("omits description when there is no title", async () => {
    const writer = fakeWriter();
    const appointment = await createInternalEvent(writer, {
      code: "day-off",
      practitionerReferences: ["Practitioner/pr1"],
      scheduleReferences: ["Schedule/s1"],
      start: "2026-07-07T04:00:00.000Z",
      end: "2026-07-08T04:00:00.000Z",
    });
    expect("description" in appointment).toBe(false);
  });
});

describe("deleteInternalEvent", () => {
  it("deletes the blocking slots first, then the appointment", async () => {
    const writer = fakeWriter();
    await deleteInternalEvent(writer, eventAppointment());
    expect(writer.deleted).toEqual(["Slot/sl1", "Slot/sl2", "Appointment/ev1"]);
  });

  it("tolerates already-gone slots (retryable convergence)", async () => {
    const writer = fakeWriter({ failSlotDelete: "sl1" });
    await deleteInternalEvent(writer, eventAppointment());
    expect(writer.deleted).toEqual(["Slot/sl2", "Appointment/ev1"]);
  });

  it("refuses to delete a non-internal appointment (patient bookings are untouchable here)", async () => {
    const writer = fakeWriter();
    const booking = eventAppointment({ appointmentType: undefined });
    await expect(deleteInternalEvent(writer, booking)).rejects.toBeInstanceOf(
      NotAnInternalEventError,
    );
    expect(writer.deleted).toEqual([]);
  });

  it("refuses when a patient somehow participates, even with our code present", async () => {
    const writer = fakeWriter();
    const malformed = eventAppointment({
      participant: [{ actor: { reference: "Patient/pt1" }, status: "accepted" }],
    });
    await expect(deleteInternalEvent(writer, malformed)).rejects.toBeInstanceOf(
      NotAnInternalEventError,
    );
    expect(writer.deleted).toEqual([]);
  });
});

describe("isInternalEvent / internalEventCode", () => {
  it("recognizes our CodeSystem and rejects everything else", () => {
    expect(isInternalEvent(eventAppointment())).toBe(true);
    expect(internalEventCode(eventAppointment())).toBe("meeting");
    const booking = eventAppointment({
      appointmentType: { coding: [{ system: "http://example.test/other", code: "meeting" }] },
    });
    expect(isInternalEvent(booking)).toBe(false);
    expect(internalEventCode(booking)).toBeUndefined();
  });
});
