import type { Appointment, Resource } from "@medibun/fhir-types";
import { TIMEZONE_EXTENSION_URL } from "@medibun/medplum-backend";
import { describe, expect, it, vi } from "vitest";

import {
  createEventsService,
  InvalidEventRequestError,
  UnknownEventError,
  type EventsUserClient,
  type EventsWriter,
} from "./events.js";

const TZ = "America/New_York";

const schedulesBundle = {
  resourceType: "Bundle",
  type: "searchset",
  entry: [
    {
      resource: { resourceType: "Schedule", id: "s1", actor: [{ reference: "Practitioner/pr1" }] },
    },
    {
      resource: { resourceType: "Schedule", id: "s2", actor: [{ reference: "Practitioner/pr1" }] },
    },
    {
      resource: { resourceType: "Schedule", id: "s3", actor: [{ reference: "Practitioner/pr2" }] },
    },
    {
      resource: {
        resourceType: "Practitioner",
        id: "pr1",
        name: [{ given: ["Riley"], family: "Reyes" }],
        extension: [{ url: TIMEZONE_EXTENSION_URL, valueCode: TZ }],
      },
    },
    {
      resource: {
        resourceType: "Practitioner",
        id: "pr2",
        name: [{ given: ["Maya"], family: "Chen" }],
        extension: [{ url: TIMEZONE_EXTENSION_URL, valueCode: TZ }],
      },
    },
  ],
};

/** Split principals (the security-review remediation): reads go through the USER
 *  client (the caller's own token), writes through the service WRITER — the fakes are
 *  separate objects so a read on the writer (or vice versa) explodes the test. */
function fakeClients(opts?: { read?: Record<string, Appointment | undefined> }) {
  const created: Resource[] = [];
  const deleted: string[] = [];
  const userTokens: string[] = [];
  let nextSlot = 0;
  const userClient = {
    get: vi.fn().mockResolvedValue(schedulesBundle),
    post: vi.fn(),
    readResource: vi.fn().mockImplementation((type: string, id: string) => {
      const key = `${type}/${id}`;
      if (opts?.read && key in opts.read) {
        return Promise.resolve(opts.read[key]);
      }
      return Promise.reject(new Error(`unexpected read ${key}`));
    }),
  };
  const writer = {
    async createResource<T extends Resource>(resource: T): Promise<T> {
      const withId = {
        ...resource,
        id: resource.resourceType === "Slot" ? `sl${++nextSlot}` : "ev1",
      };
      created.push(withId);
      return withId as T;
    },
    async deleteResource(resourceType: "Appointment" | "Slot", id: string): Promise<unknown> {
      deleted.push(`${resourceType}/${id}`);
      return undefined;
    },
  };
  const service = createEventsService({
    getFhirClient: () => Promise.resolve(writer as EventsWriter),
    userClient: (accessToken) => {
      userTokens.push(accessToken);
      return userClient as unknown as EventsUserClient;
    },
  });
  return { service, userClient, created, deleted, userTokens };
}

const user = { profileReference: "Practitioner/pr1", accessToken: "user-tok" };

const internalEvent = (overrides?: Partial<Appointment>): Appointment => ({
  resourceType: "Appointment",
  id: "ev1",
  status: "booked",
  appointmentType: {
    coding: [{ system: "https://medibun.com/fhir/CodeSystem/internal-events", code: "meeting" }],
  },
  start: "2026-07-06T16:00:00.000Z",
  end: "2026-07-06T16:30:00.000Z",
  slot: [{ reference: "Slot/sl9" }],
  participant: [{ actor: { reference: "Practitioner/pr1" }, status: "accepted" }],
  ...overrides,
});

describe("createEvent", () => {
  it("creates a meeting across practitioners, blocking every schedule they own", async () => {
    const { service, created, userClient, userTokens } = fakeClients();
    const event = await service.createEvent(user, {
      type: "meeting",
      title: "  Team huddle  ",
      practitionerIds: ["pr1", "pr2"],
      date: "2026-07-06",
      startTime: "12:00",
      endTime: "12:30",
    });
    // Wall times land as practice-local instants (12:00 EDT = 16:00Z) — the BFF owns
    // the conversion; clients never send UTC.
    expect(event).toEqual({
      id: "ev1",
      type: "meeting",
      title: "Team huddle",
      practitionerIds: ["pr1", "pr2"],
      start: "2026-07-06T16:00:00.000Z",
      end: "2026-07-06T16:30:00.000Z",
    });
    // pr1 owns two schedules, pr2 one — all three get a busy-unavailable Slot.
    const slots = created.filter((r) => r.resourceType === "Slot");
    expect(slots).toHaveLength(3);
    // The schedules read ran AS THE CALLER (security remediation): the user client got
    // their token; the writer never reads.
    expect(userTokens).toEqual(["user-tok"]);
    expect(userClient.get).toHaveBeenCalled();
  });

  it("derives full practice-local day bounds for a day off (DST-safe BFF ownership)", async () => {
    const { service, created } = fakeClients();
    const event = await service.createEvent(user, {
      type: "day-off",
      practitionerIds: ["pr2"],
      date: "2026-07-07",
    });
    // 2026-07-07 EDT: 04:00Z → next-day 04:00Z.
    expect(event.start).toBe("2026-07-07T04:00:00.000Z");
    expect(event.end).toBe("2026-07-08T04:00:00.000Z");
    expect(created.filter((r) => r.resourceType === "Slot")).toHaveLength(1);
  });

  const rejected: { why: string; request: object }[] = [
    {
      why: "unknown type",
      request: { type: "vacation", practitionerIds: ["pr1"], date: "2026-07-07" },
    },
    {
      why: "no practitioners",
      request: { type: "day-off", practitionerIds: [], date: "2026-07-07" },
    },
    {
      why: "day off is per-practitioner",
      request: { type: "day-off", practitionerIds: ["pr1", "pr2"], date: "2026-07-07" },
    },
    {
      why: "impossible date",
      request: { type: "day-off", practitionerIds: ["pr1"], date: "2026-02-31" },
    },
    { why: "day off needs a date", request: { type: "day-off", practitionerIds: ["pr1"] } },
    {
      why: "block needs start AND end times",
      request: { type: "block", practitionerIds: ["pr1"], date: "2026-07-06", startTime: "12:00" },
    },
    {
      why: "end before start",
      request: {
        type: "block",
        practitionerIds: ["pr1"],
        date: "2026-07-06",
        startTime: "13:00",
        endTime: "12:00",
      },
    },
    {
      why: "not a wall time",
      request: {
        type: "meeting",
        practitionerIds: ["pr1"],
        date: "2026-07-06",
        startTime: "25:99",
        endTime: "26:00",
      },
    },
    {
      why: "title too long",
      request: {
        type: "block",
        practitionerIds: ["pr1"],
        title: "x".repeat(81),
        date: "2026-07-06",
        startTime: "12:00",
        endTime: "13:00",
      },
    },
    {
      why: "unknown practitioner",
      request: { type: "day-off", practitionerIds: ["nobody"], date: "2026-07-07" },
    },
  ];

  it.each(rejected)("rejects: $why", async ({ request }) => {
    const { service, created } = fakeClients();
    await expect(
      service.createEvent(user, request as Parameters<typeof service.createEvent>[1]),
    ).rejects.toBeInstanceOf(InvalidEventRequestError);
    expect(created).toHaveLength(0);
  });
});

describe("deleteEvent", () => {
  it("probe-reads as the caller, then deletes slots and appointment via the writer", async () => {
    const { service, deleted, userClient, userTokens } = fakeClients({
      read: { "Appointment/ev1": internalEvent() },
    });
    await service.deleteEvent(user, "ev1");
    expect(deleted).toEqual(["Slot/sl9", "Appointment/ev1"]);
    // The read that decides visibility ran under the CALLER's token — a cross-org id
    // is policy-hidden there and 404s like an unknown id (security remediation).
    expect(userTokens).toEqual(["user-tok"]);
    expect(userClient.readResource).toHaveBeenCalledWith("Appointment", "ev1");
  });

  it("404s an unknown (or policy-hidden) id", async () => {
    const { service } = fakeClients({ read: { "Appointment/ev1": undefined } });
    await expect(service.deleteEvent(user, "ev1")).rejects.toBeInstanceOf(UnknownEventError);
  });

  it("404s a patient appointment — bookings are untouchable through the events path", async () => {
    const booking = internalEvent({
      appointmentType: undefined,
      participant: [{ actor: { reference: "Patient/pt1" }, status: "accepted" }],
    });
    const { service, deleted } = fakeClients({ read: { "Appointment/ev1": booking } });
    await expect(service.deleteEvent(user, "ev1")).rejects.toBeInstanceOf(UnknownEventError);
    expect(deleted).toHaveLength(0);
  });
});
