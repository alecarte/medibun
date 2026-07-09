import type { Appointment, Resource } from "@medibun/fhir-types";
import { TIMEZONE_EXTENSION_URL } from "@medibun/medplum-backend";
import { describe, expect, it, vi } from "vitest";

import {
  CANCELLATION_REASON_SYSTEM,
  createCancelService,
  InvalidCancelRequestError,
  type CancelUserClient,
  type CancelWriter,
} from "./cancel.js";
import { InvalidTransitionError, UnknownAppointmentError } from "./staff.js";
import { StatusConflictError } from "@medibun/medplum-backend";

const TZ = "America/New_York";
const SERVICES = "https://medibun.com/fhir/CodeSystem/services";

const schedulesBundle = {
  resourceType: "Bundle",
  type: "searchset",
  entry: [
    {
      resource: {
        resourceType: "Schedule",
        id: "s1",
        actor: [{ reference: "Practitioner/pr1" }],
        serviceType: [{ coding: [{ system: SERVICES, code: "svc-botox" }] }],
      },
    },
    {
      resource: {
        resourceType: "Practitioner",
        id: "pr1",
        name: [{ given: ["Riley"], family: "Reyes" }],
        extension: [{ url: TIMEZONE_EXTENSION_URL, valueCode: TZ }],
      },
    },
  ],
};

/** A $book-shaped booking: 2:00–2:30 PM EDT with our service code and a slot ref. */
const booking = (overrides?: Partial<Appointment>): Appointment => ({
  resourceType: "Appointment",
  id: "a1",
  meta: { versionId: "7" },
  status: "booked",
  serviceType: [{ coding: [{ system: SERVICES, code: "svc-botox" }] }],
  start: "2026-07-09T18:00:00.000Z",
  end: "2026-07-09T18:30:00.000Z",
  slot: [{ reference: "Slot/sl-old" }],
  participant: [
    { actor: { reference: "Patient/pt1" }, status: "accepted" },
    { actor: { reference: "Practitioner/pr1" }, status: "accepted" },
  ],
  ...overrides,
});

/** The same booking after our cancel wrote it. */
const cancelled = (overrides?: Partial<Appointment>): Appointment =>
  booking({
    status: "cancelled",
    cancelationReason: {
      coding: [{ system: CANCELLATION_REASON_SYSTEM, code: "patient" }],
    },
    slot: undefined,
    ...overrides,
  });

function fakeClients(opts?: {
  appointment?: Appointment | undefined;
  busy?: boolean;
  /** Free at the pre-check, taken by the re-check (the TOCTOU regression). */
  busyOnRecheck?: boolean;
  patchFails?: boolean;
  matches?: number;
}) {
  const created: Resource[] = [];
  const deleted: string[] = [];
  const patches: unknown[][] = [];
  let slotQueries = 0;
  const busyEntry = (id: string) => ({
    resource: {
      resourceType: "Slot",
      id,
      schedule: { reference: "Schedule/s1" },
      status: "busy",
      start: "2026-07-09T18:00:00.000Z",
      end: "2026-07-09T18:30:00.000Z",
    },
  });
  const userClient = {
    get: vi.fn().mockImplementation((url: string) => {
      if (url.startsWith("fhir/R4/Schedule?")) {
        return Promise.resolve(schedulesBundle);
      }
      if (url.startsWith("fhir/R4/Slot?")) {
        slotQueries += 1;
        const recheck = slotQueries >= 2;
        const entry = opts?.busy
          ? [busyEntry("sl-other")]
          : opts?.busyOnRecheck && recheck
            ? [busyEntry("sl-racer")]
            : [];
        return Promise.resolve({ resourceType: "Bundle", type: "searchset", entry });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    }),
    post: vi.fn(),
    readResource: vi.fn().mockImplementation((type: string, id: string) => {
      if (type === "Appointment" && id === "a1") {
        return Promise.resolve("appointment" in (opts ?? {}) ? opts!.appointment : booking());
      }
      return Promise.reject(new Error(`unexpected read ${type}/${id}`));
    }),
    patchResource: vi.fn().mockImplementation((_t: string, _id: string, ops: unknown[]) => {
      if (opts?.patchFails) {
        return Promise.reject(new StatusConflictError());
      }
      patches.push(ops);
      return Promise.resolve(booking());
    }),
  };
  const writer = {
    async createResource<T extends Resource>(resource: T): Promise<T> {
      const withId = { ...resource, id: "sl-new" };
      created.push(withId);
      return withId as T;
    },
    async deleteResource(resourceType: "Appointment" | "Slot", id: string): Promise<unknown> {
      deleted.push(`${resourceType}/${id}`);
      return undefined;
    },
  };
  const countMoveUpMatches = vi.fn().mockResolvedValue(opts?.matches ?? 0);
  const service = createCancelService({
    getFhirClient: () => Promise.resolve(writer as CancelWriter),
    userClient: () => userClient as unknown as CancelUserClient,
    countMoveUpMatches,
  });
  return { service, userClient, created, deleted, patches, countMoveUpMatches };
}

const user = { profileReference: "Practitioner/pr-staff", accessToken: "tok" };

describe("cancelAppointment", () => {
  it("patches status→cancelled with the coded reason, then frees the protector slot", async () => {
    const { service, patches, deleted, countMoveUpMatches } = fakeClients({ matches: 2 });
    await expect(service.cancelAppointment(user, "a1", "patient")).resolves.toEqual({
      id: "a1",
      status: "cancelled",
      moveUpMatches: 2,
    });
    expect(patches[0]).toEqual([
      { op: "test", path: "/status", value: "booked" },
      { op: "test", path: "/meta/versionId", value: "7" },
      { op: "replace", path: "/status", value: "cancelled" },
      {
        op: "add",
        path: "/cancelationReason",
        value: { coding: [{ system: CANCELLATION_REASON_SYSTEM, code: "patient" }] },
      },
      { op: "remove", path: "/slot" },
    ]);
    expect(deleted).toEqual(["Slot/sl-old"]);
    expect(countMoveUpMatches).toHaveBeenCalledWith("svc-botox", "pr1", "a1");
  });

  it("skips the schedules read when the appointment carries its own protector refs", async () => {
    // The schedules fetch only feeds resolveBookedSlots' window-search FALLBACK —
    // the common $book path (slot[] populated) must not pay that round-trip.
    const { service, userClient } = fakeClients();
    await service.cancelAppointment(user, "a1", "patient");
    const urls = userClient.get.mock.calls.map((call) => String(call[0]));
    expect(urls.filter((u) => u.startsWith("fhir/R4/Schedule?"))).toEqual([]);
  });

  it("resolves protectors via the schedule-scoped fallback when slot refs are absent", async () => {
    const { service, userClient, deleted } = fakeClients({
      appointment: booking({ slot: undefined }),
    });
    await service.cancelAppointment(user, "a1", "patient");
    const urls = userClient.get.mock.calls.map((call) => String(call[0]));
    expect(urls.filter((u) => u.startsWith("fhir/R4/Schedule?"))).toHaveLength(1);
    // The fallback search found nothing busy in the fake → nothing deleted, and
    // crucially the search ran scoped to the appointment's own schedule.
    expect(urls.some((u) => u.startsWith("fhir/R4/Slot?") && u.includes("Schedule%2Fs1"))).toBe(
      true,
    );
    expect(deleted).toEqual([]);
  });

  it("rejects a reason outside the coded set (never free text)", async () => {
    const { service, patches } = fakeClients();
    await expect(
      service.cancelAppointment(user, "a1", "ran out of botox" as never),
    ).rejects.toBeInstanceOf(InvalidCancelRequestError);
    expect(patches).toHaveLength(0);
  });

  it("answers unknown ids and internal events identically (not found)", async () => {
    await expect(
      fakeClients({ appointment: undefined }).service.cancelAppointment(user, "a1", "patient"),
    ).rejects.toBeInstanceOf(UnknownAppointmentError);
    const event = booking({
      appointmentType: {
        coding: [
          { system: "https://medibun.com/fhir/CodeSystem/internal-events", code: "meeting" },
        ],
      },
      participant: [{ actor: { reference: "Practitioner/pr1" }, status: "accepted" }],
    });
    await expect(
      fakeClients({ appointment: event }).service.cancelAppointment(user, "a1", "patient"),
    ).rejects.toBeInstanceOf(UnknownAppointmentError);
  });

  it("refuses non-scheduled appointments (arrived patients are in the building)", async () => {
    const { service } = fakeClients({ appointment: booking({ status: "arrived" }) });
    await expect(service.cancelAppointment(user, "a1", "patient")).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
  });

  it("maps a lost patch race to the 409 contract and deletes nothing", async () => {
    const { service, deleted } = fakeClients({ patchFails: true });
    await expect(service.cancelAppointment(user, "a1", "patient")).rejects.toBeInstanceOf(
      StatusConflictError,
    );
    expect(deleted).toEqual([]);
  });
});

describe("restoreAppointment", () => {
  it("re-protects the window first, then patches cancelled→booked and clears the reason", async () => {
    const { service, patches, created, deleted } = fakeClients({ appointment: cancelled() });
    await expect(service.restoreAppointment(user, "a1")).resolves.toEqual({
      id: "a1",
      status: "scheduled",
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      resourceType: "Slot",
      schedule: { reference: "Schedule/s1" },
      status: "busy",
      start: "2026-07-09T18:00:00.000Z",
      end: "2026-07-09T18:30:00.000Z",
    });
    expect(patches[0]).toEqual([
      { op: "test", path: "/status", value: "cancelled" },
      { op: "test", path: "/meta/versionId", value: "7" },
      { op: "replace", path: "/status", value: "booked" },
      { op: "remove", path: "/cancelationReason" },
      { op: "add", path: "/slot", value: [{ reference: "Slot/sl-new" }] },
    ]);
    expect(deleted).toEqual([]);
  });

  it("409s honestly when the freed window was taken inside the undo period", async () => {
    const { service, created } = fakeClients({ appointment: cancelled(), busy: true });
    await expect(service.restoreAppointment(user, "a1")).rejects.toBeInstanceOf(
      StatusConflictError,
    );
    expect(created).toHaveLength(0); // pre-check refused — nothing minted
  });

  it("loses the re-check race cleanly: the minted protector is compensated away", async () => {
    const { service, created, deleted } = fakeClients({
      appointment: cancelled(),
      busyOnRecheck: true,
    });
    await expect(service.restoreAppointment(user, "a1")).rejects.toBeInstanceOf(
      StatusConflictError,
    );
    expect(created).toHaveLength(1);
    expect(deleted).toEqual(["Slot/sl-new"]);
  });

  it("compensates the protector when the patch loses", async () => {
    const { service, deleted } = fakeClients({ appointment: cancelled(), patchFails: true });
    await expect(service.restoreAppointment(user, "a1")).rejects.toBeInstanceOf(
      StatusConflictError,
    );
    expect(deleted).toEqual(["Slot/sl-new"]);
  });

  it("refuses non-cancelled appointments (the undo raced something else)", async () => {
    const { service } = fakeClients({ appointment: booking() });
    await expect(service.restoreAppointment(user, "a1")).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
  });

  it("fails toward blocking when no own schedule resolves (cannot re-protect)", async () => {
    const { service, created } = fakeClients({
      appointment: cancelled({ serviceType: undefined }),
    });
    await expect(service.restoreAppointment(user, "a1")).rejects.toBeInstanceOf(
      StatusConflictError,
    );
    expect(created).toHaveLength(0);
  });
});
