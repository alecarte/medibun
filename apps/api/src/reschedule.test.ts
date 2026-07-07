import type { Appointment, Resource } from "@medibun/fhir-types";
import { TIMEZONE_EXTENSION_URL } from "@medibun/medplum-backend";
import { describe, expect, it, vi } from "vitest";

import {
  createRescheduleService,
  InvalidRescheduleRequestError,
  type RescheduleUserClient,
  type RescheduleWriter,
} from "./reschedule.js";
import { InvalidTransitionError, UnknownAppointmentError } from "./staff.js";
import { StatusConflictError } from "@medibun/medplum-backend";

const TZ = "America/New_York";
const SERVICES = "https://medibun.com/fhir/CodeSystem/services";

const schedule = (id: string, practitioner: string, code: string) => ({
  resourceType: "Schedule",
  id,
  actor: [{ reference: `Practitioner/${practitioner}` }],
  serviceType: [{ coding: [{ system: SERVICES, code }] }],
});

const practitioner = (id: string, family: string) => ({
  resourceType: "Practitioner",
  id,
  name: [{ given: ["Riley"], family }],
  extension: [{ url: TIMEZONE_EXTENSION_URL, valueCode: TZ }],
});

const schedulesBundle = {
  resourceType: "Bundle",
  type: "searchset",
  entry: [
    { resource: schedule("s1", "pr1", "svc-botox") },
    { resource: schedule("s2", "pr2", "svc-botox") },
    { resource: schedule("s3", "pr2", "svc-lip-filler") },
    { resource: practitioner("pr1", "Reyes") },
    { resource: practitioner("pr2", "Chen") },
  ],
};

/** A $book-shaped booking: 2:00–2:30 PM EDT with our service code and a busy slot ref. */
const booking = (overrides?: Partial<Appointment>): Appointment => ({
  resourceType: "Appointment",
  id: "a1",
  meta: { versionId: "7" },
  status: "booked",
  serviceType: [{ coding: [{ system: SERVICES, code: "svc-botox" }] }],
  start: "2026-07-06T18:00:00.000Z",
  end: "2026-07-06T18:30:00.000Z",
  slot: [{ reference: "Slot/sl-old" }],
  participant: [
    { actor: { reference: "Patient/pt1" }, status: "accepted" },
    { actor: { reference: "Practitioner/pr1" }, status: "accepted" },
  ],
  ...overrides,
});

function fakeClients(opts?: {
  appointment?: Appointment | undefined;
  busy?: boolean;
  /** The window is free at the pre-check but taken by the RE-CHECK (a racing move
   *  landed between our check and our claim — the TOCTOU regression). */
  busyOnRecheck?: boolean;
  /** The re-check sees the protector this move just minted (the realistic read
   *  of our own write) — it must be excluded, not read as a conflict. */
  recheckSeesOwnSlot?: boolean;
  patchFails?: boolean;
  timezoneless?: boolean;
}) {
  const created: Resource[] = [];
  const deleted: string[] = [];
  const patches: unknown[] = [];
  let slotQueries = 0;
  const busyEntry = (id: string, start: string, end: string) => ({
    resource: {
      resourceType: "Slot",
      id,
      schedule: { reference: "Schedule/s2" },
      status: "busy",
      start,
      end,
    },
  });
  const userClient = {
    get: vi.fn().mockImplementation((url: string) => {
      if (url.startsWith("fhir/R4/Schedule?")) {
        if (opts?.timezoneless) {
          return Promise.resolve({
            ...schedulesBundle,
            entry: schedulesBundle.entry.map((e) =>
              e.resource.resourceType === "Practitioner"
                ? { resource: { ...e.resource, extension: [] } }
                : e,
            ),
          });
        }
        return Promise.resolve(schedulesBundle);
      }
      if (url.startsWith("fhir/R4/Slot?")) {
        slotQueries += 1;
        const recheck = slotQueries >= 2;
        const entry = opts?.busy
          ? [busyEntry("sl-other", "2026-07-06T19:00:00.000Z", "2026-07-06T19:30:00.000Z")]
          : opts?.busyOnRecheck && recheck
            ? [busyEntry("sl-racer", "2026-07-06T19:15:00.000Z", "2026-07-06T19:45:00.000Z")]
            : opts?.recheckSeesOwnSlot && recheck
              ? [busyEntry("sl-new", "2026-07-06T19:15:00.000Z", "2026-07-06T19:45:00.000Z")]
              : [];
        return Promise.resolve({ resourceType: "Bundle", type: "searchset", entry });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    }),
    post: vi.fn(),
    readResource: vi.fn().mockImplementation((type: string, id: string) => {
      if (type === "Appointment" && id === "a1" && "appointment" in (opts ?? {})) {
        return Promise.resolve(opts!.appointment);
      }
      if (type === "Appointment" && id === "a1") {
        return Promise.resolve(booking());
      }
      return Promise.reject(new Error(`unexpected read ${type}/${id}`));
    }),
    patchResource: vi.fn().mockImplementation(() => {
      if (opts?.patchFails) {
        return Promise.reject(new StatusConflictError());
      }
      patches.push(true);
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
  const service = createRescheduleService({
    getFhirClient: () => Promise.resolve(writer as RescheduleWriter),
    userClient: () => userClient as unknown as RescheduleUserClient,
  });
  return { service, userClient, created, deleted };
}

const user = { profileReference: "Practitioner/pr-noor", accessToken: "user-tok" };

describe("rescheduleAppointment", () => {
  it("moves time + practitioner: new busy slot on the target schedule, patch, old slot deleted", async () => {
    const { service, userClient, created, deleted } = fakeClients();
    const result = await service.rescheduleAppointment(user, "a1", {
      date: "2026-07-06",
      startTime: "15:15", // 3:15 PM EDT = 19:15Z
      practitionerId: "pr2",
    });
    expect(result).toEqual({
      id: "a1",
      practitionerId: "pr2",
      start: "2026-07-06T19:15:00.000Z",
      end: "2026-07-06T19:45:00.000Z", // duration preserved (30 min)
    });
    // New protector on pr2's svc-botox schedule (s2), same blocking semantics as $book.
    const slot = created[0] as { schedule?: { reference?: string }; status?: string };
    expect(slot.schedule?.reference).toBe("Schedule/s2");
    expect(slot.status).toBe("busy");
    // The patch ran AS THE CALLER with test-and-sets on the current start AND the
    // versionId — the versionId test is what makes a same-start concurrent write
    // (practitioner-only swap on another station) lose instead of silently winning.
    expect(userClient.patchResource).toHaveBeenCalledWith(
      "Appointment",
      "a1",
      expect.arrayContaining([
        { op: "test", path: "/start", value: "2026-07-06T18:00:00.000Z" },
        { op: "test", path: "/meta/versionId", value: "7" },
        { op: "replace", path: "/start", value: "2026-07-06T19:15:00.000Z" },
        { op: "replace", path: "/end", value: "2026-07-06T19:45:00.000Z" },
      ]),
    );
    // `add`, not `replace`: RFC 6902 rejects replace on a missing member, and
    // whether $book populates slot[]/participant is a live-verify unknown.
    const ops = userClient.patchResource.mock.calls[0]![2] as { op: string; path: string }[];
    expect(ops.find((o) => o.path === "/slot")?.op).toBe("add");
    expect(ops.find((o) => o.path === "/participant")?.op).toBe("add");
    expect(deleted).toEqual(["Slot/sl-old"]);
  });

  it("keeps the patient participant and swaps only the practitioner", async () => {
    const { service, userClient } = fakeClients();
    await service.rescheduleAppointment(user, "a1", {
      date: "2026-07-06",
      startTime: "15:15",
      practitionerId: "pr2",
    });
    const ops = userClient.patchResource.mock.calls[0]![2] as {
      op: string;
      path: string;
      value?: unknown;
    }[];
    const participants = ops.find((o) => o.path === "/participant")?.value as {
      actor: { reference: string };
    }[];
    expect(participants.map((p) => p.actor.reference)).toEqual(["Patient/pt1", "Practitioner/pr2"]);
  });

  it("refuses a taken window with a conflict (client refetches)", async () => {
    const { service, created } = fakeClients({ busy: true });
    await expect(
      service.rescheduleAppointment(user, "a1", {
        date: "2026-07-06",
        startTime: "15:00",
        practitionerId: "pr2",
      }),
    ).rejects.toBeInstanceOf(StatusConflictError);
    expect(created).toHaveLength(0);
  });

  it("re-checks the window AFTER minting the protector: a racing move 409s and compensates (TOCTOU regression)", async () => {
    // Both stations pass the pre-check on the same open window; the loser must see
    // the winner's slot once its own claim exists — not double-book silently.
    const { service, created, deleted } = fakeClients({ busyOnRecheck: true });
    await expect(
      service.rescheduleAppointment(user, "a1", {
        date: "2026-07-06",
        startTime: "15:15",
        practitionerId: "pr2",
      }),
    ).rejects.toBeInstanceOf(StatusConflictError);
    expect(created).toHaveLength(1); // pre-check passed, so the protector was minted...
    expect(deleted).toEqual(["Slot/sl-new"]); // ...and compensated; the old slot untouched
  });

  it("the re-check ignores the protector this move just minted", async () => {
    const { service, deleted } = fakeClients({ recheckSeesOwnSlot: true });
    const result = await service.rescheduleAppointment(user, "a1", {
      date: "2026-07-06",
      startTime: "15:15",
      practitionerId: "pr2",
    });
    expect(result.start).toBe("2026-07-06T19:15:00.000Z");
    expect(deleted).toEqual(["Slot/sl-old"]);
  });

  it("reschedules a $book-shaped appointment WITHOUT slot refs: add-ops, nothing foreign deleted", async () => {
    const { service, userClient, deleted } = fakeClients({
      appointment: booking({ slot: undefined }),
    });
    await service.rescheduleAppointment(user, "a1", {
      date: "2026-07-06",
      startTime: "15:15",
      practitionerId: "pr2",
    });
    // `replace /slot` would reject the whole patch on this stack shape (RFC 6902).
    const ops = userClient.patchResource.mock.calls[0]![2] as { op: string; path: string }[];
    expect(ops.find((o) => o.path === "/slot")?.op).toBe("add");
    expect(deleted).toEqual([]); // no resolvable old protector — nothing foreign deleted
  });

  it("compensates a lost patch race: the new slot is deleted again", async () => {
    // The stub throws the already-typed StatusConflictError; the raw
    // OperationOutcomeError→StatusConflictError mapping the service routes every
    // patch failure through (rethrowPatchFailure) is pinned in medplum-backend,
    // where the SDK error class lives.
    const { service, created, deleted } = fakeClients({ patchFails: true });
    await expect(
      service.rescheduleAppointment(user, "a1", {
        date: "2026-07-06",
        startTime: "15:15",
        practitionerId: "pr2",
      }),
    ).rejects.toBeInstanceOf(StatusConflictError);
    expect(created).toHaveLength(1);
    expect(deleted).toEqual(["Slot/sl-new"]); // compensation, old slot untouched
  });

  it("fallback own-slot resolution never claims a foreign identical-window slot (HIGH regression)", async () => {
    // No slot refs on the appointment (the $book live-verify unknown) AND another
    // booking's protector occupies the exact target window on the target schedule.
    // Before the fix, the unscoped fallback claimed that slot as "ours": the freeness
    // check passed and the foreign protector was deleted after the move. Now it must
    // 409 and delete nothing.
    const { service, created, deleted } = fakeClients({
      appointment: booking({ slot: undefined }),
      busy: true,
    });
    await expect(
      service.rescheduleAppointment(user, "a1", {
        date: "2026-07-06",
        startTime: "15:00", // exactly the foreign slot's 19:00Z window
        practitionerId: "pr2",
      }),
    ).rejects.toBeInstanceOf(StatusConflictError);
    expect(created).toHaveLength(0);
    expect(deleted).toHaveLength(0);
  });

  it("refuses to guess UTC when no schedule actor carries the practice timezone", async () => {
    const { service } = fakeClients({ timezoneless: true });
    await expect(
      service.rescheduleAppointment(user, "a1", {
        date: "2026-07-06",
        startTime: "15:15",
        practitionerId: "pr2",
      }),
    ).rejects.toThrow(/timezone/);
  });

  it("refuses to move a checked-in patient (scheduled-only, decided at the interview)", async () => {
    const { service } = fakeClients({ appointment: booking({ status: "arrived" }) });
    await expect(
      service.rescheduleAppointment(user, "a1", {
        date: "2026-07-06",
        startTime: "15:15",
        practitionerId: "pr1",
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("404s internal events and unknown ids identically", async () => {
    const internal = booking({
      appointmentType: {
        coding: [
          { system: "https://medibun.com/fhir/CodeSystem/internal-events", code: "meeting" },
        ],
      },
      participant: [{ actor: { reference: "Practitioner/pr1" }, status: "accepted" }],
    });
    const { service } = fakeClients({ appointment: internal });
    await expect(
      service.rescheduleAppointment(user, "a1", {
        date: "2026-07-06",
        startTime: "15:15",
        practitionerId: "pr1",
      }),
    ).rejects.toBeInstanceOf(UnknownAppointmentError);

    const missing = fakeClients({ appointment: undefined });
    await expect(
      missing.service.rescheduleAppointment(user, "a1", {
        date: "2026-07-06",
        startTime: "15:15",
        practitionerId: "pr1",
      }),
    ).rejects.toBeInstanceOf(UnknownAppointmentError);
  });

  it("rejects a target practitioner without a schedule for the service", async () => {
    const { service } = fakeClients();
    await expect(
      service.rescheduleAppointment(user, "a1", {
        date: "2026-07-06",
        startTime: "15:15",
        practitionerId: "pr-nobody",
      }),
    ).rejects.toBeInstanceOf(InvalidRescheduleRequestError);
  });

  it("rejects malformed dates and wall times", async () => {
    const { service } = fakeClients();
    for (const request of [
      { date: "2026-02-31", startTime: "15:15", practitionerId: "pr1" },
      { date: "2026-07-06", startTime: "25:99", practitionerId: "pr1" },
      { date: "2026-07-06", startTime: "15:15", practitionerId: "" },
    ]) {
      await expect(service.rescheduleAppointment(user, "a1", request)).rejects.toBeInstanceOf(
        InvalidRescheduleRequestError,
      );
    }
  });
});
