import { createApiClient, BookingError, LoginError, StaffError } from "@medibun/api-client";
import {
  SlotTakenError,
  StatusConflictError,
  TIMEZONE_EXTENSION_URL,
} from "@medibun/medplum-backend";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp, type AuthDeps } from "./app.js";
import { createBookingService } from "./booking.js";
import { createCancelService } from "./cancel.js";
import * as dbSchema from "./db/schema.js";
import { bootTestDb } from "./db/test-db.js";
import { createMoveUpService } from "./move-up.js";
import { createStaffService } from "./staff.js";
import type { ServiceRow } from "./services/catalog.js";

/**
 * Cross-package contract test (testing.md): the real @medibun/api-client speaks to the
 * real BFF app in-process, so a drift in route shape or DTO breaks here, not in an app.
 * Booking runs the REAL booking service too — only the FHIR wire is stubbed.
 */
const user = { profileReference: "Patient/p-1", accessToken: "at-1" };

const NOW = new Date("2026-07-06T12:00:00.000Z");
const SLOT_START = "2026-07-07T14:00:00.000Z";
const SLOT_END = "2026-07-07T14:30:00.000Z";

const botoxRow: ServiceRow = {
  id: "botox-standard",
  code: "svc-botox",
  name: "Botox",
  description: "Smooths dynamic lines.",
  durationMinutes: 30,
  priceCents: 39_500,
  categoryColor: "sage",
  healthcareServiceId: "hs-1",
  stripeProductId: null,
  active: true,
  createdAt: NOW,
};

const scheduleBundle = {
  resourceType: "Bundle",
  type: "searchset",
  entry: [
    {
      search: { mode: "match" },
      resource: {
        resourceType: "Schedule",
        id: "sched-1",
        actor: [{ reference: "Practitioner/prac-1" }],
      },
    },
    {
      search: { mode: "include" },
      resource: {
        resourceType: "Practitioner",
        id: "prac-1",
        name: [{ given: ["Riley"], family: "Reyes" }],
        extension: [{ url: TIMEZONE_EXTENSION_URL, valueCode: "America/New_York" }],
      },
    },
  ],
};

const findBundle = {
  resourceType: "Bundle",
  type: "searchset",
  entry: [{ resource: { resourceType: "Slot", status: "free", start: SLOT_START, end: SLOT_END } }],
};

const bookedBundle = {
  resourceType: "Bundle",
  entry: [
    { resource: { resourceType: "Appointment", id: "appt-1", start: SLOT_START, end: SLOT_END } },
  ],
};

function makeBooking(post?: (url: string, body?: unknown) => Promise<unknown>) {
  return createBookingService({
    catalog: {
      listActive: () => Promise.resolve([botoxRow]),
      getByCode: (code) => Promise.resolve(code === "svc-botox" ? botoxRow : undefined),
    },
    getFhirClient: () =>
      Promise.resolve({
        get: (url: string) =>
          Promise.resolve(url.startsWith("fhir/R4/Schedule?") ? scheduleBundle : findBundle),
        post: post ?? (() => Promise.resolve(bookedBundle)),
      }),
    now: () => NOW,
  });
}

function makeApp(
  overrides: Partial<AuthDeps> = {},
  booking: ReturnType<typeof makeBooking> = makeBooking(),
) {
  const auth: AuthDeps = {
    login: () => Promise.resolve({ sessionId: "session-1" }),
    logout: () => Promise.resolve(),
    getUser: (sessionId) => Promise.resolve(sessionId === "session-1" ? user : null),
    getMyProfile: () =>
      Promise.resolve({ id: "p-1", name: "Synth Example", birthDate: "1990-01-01" }),
    recordAndCheckRateLimit: () => Promise.resolve(false),
    cookieSecure: false,
    ...overrides,
  };
  return createApp({
    log: () => undefined,
    checkMedplum: () => Promise.resolve(true),
    auth,
    booking,
  });
}

function makeClient(
  overrides: Partial<AuthDeps> = {},
  booking: ReturnType<typeof makeBooking> = makeBooking(),
) {
  const app = makeApp(overrides, booking);
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    app.request(input, init)) as typeof fetch;
  return createApiClient({ baseUrl: "http://bff.test", fetch: fetchImpl });
}

describe("api-client ⇄ BFF contract", () => {
  it("logs in and returns the opaque session token", async () => {
    const client = makeClient();
    await expect(client.login("synthia@example.test", "pw")).resolves.toEqual({
      sessionToken: "session-1",
    });
  });

  it("maps a BFF login failure to a typed LoginError", async () => {
    const client = makeClient({ login: () => Promise.reject(new Error("upstream down")) });
    const err = await client.login("synthia@example.test", "bad").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginError);
  });

  it("round-trips the signed-in profile DTO via bearer auth", async () => {
    const client = makeClient();
    await expect(client.getMyProfile({ sessionToken: "session-1" })).resolves.toEqual({
      id: "p-1",
      name: "Synth Example",
      birthDate: "1990-01-01",
    });
  });

  it("round-trips the signed-in profile DTO via the session cookie (web path)", async () => {
    const client = makeClient();
    await expect(client.getMyProfile({ cookie: "medibun_session=session-1" })).resolves.toEqual({
      id: "p-1",
      name: "Synth Example",
      birthDate: "1990-01-01",
    });
  });

  it("resolves undefined for an unknown session (BFF 401)", async () => {
    const client = makeClient();
    await expect(client.getMyProfile({ sessionToken: "nope" })).resolves.toBeUndefined();
  });

  it("logs out without error", async () => {
    const client = makeClient();
    await expect(client.logout({ sessionToken: "session-1" })).resolves.toBeUndefined();
  });

  it("the dev-only unauthenticated patient read is gone for good", async () => {
    const app = makeApp();
    const res = await app.request("/patients/some-id");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });
});

describe("api-client ⇄ BFF booking contract (real booking service, stubbed FHIR wire)", () => {
  const auth = { cookie: "medibun_session=session-1" };

  it("round-trips the service menu", async () => {
    const client = makeClient();
    await expect(client.listServices(auth)).resolves.toEqual([
      {
        code: "svc-botox",
        name: "Botox",
        description: "Smooths dynamic lines.",
        durationMinutes: 30,
        priceCents: 39_500,
        categoryColor: "sage",
      },
    ]);
  });

  it("maps a signed-out menu request to a typed unauthorized BookingError", async () => {
    const client = makeClient();
    const err = await client.listServices().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BookingError);
    expect((err as BookingError).code).toBe("unauthorized");
  });

  it("round-trips availability grouped by practitioner", async () => {
    const client = makeClient();
    await expect(client.getAvailability("svc-botox", auth)).resolves.toEqual({
      serviceCode: "svc-botox",
      timezone: "America/New_York",
      windowStart: NOW.toISOString(),
      windowDays: 7,
      practitioners: [
        {
          scheduleId: "sched-1",
          practitionerId: "prac-1",
          practitionerName: "Riley Reyes",
          slots: [{ start: SLOT_START, end: SLOT_END }],
        },
      ],
    });
  });

  it("maps an unknown service to a typed not_found BookingError", async () => {
    const client = makeClient();
    const err = await client.getAvailability("svc-nope", auth).catch((e: unknown) => e);
    expect((err as BookingError).code).toBe("not_found");
  });

  it("books a slot end-to-end and round-trips the confirmed appointment", async () => {
    const client = makeClient();
    await expect(
      client.book({ serviceCode: "svc-botox", scheduleId: "sched-1", start: SLOT_START }, auth),
    ).resolves.toEqual({
      id: "appt-1",
      serviceCode: "svc-botox",
      serviceName: "Botox",
      practitionerName: "Riley Reyes",
      start: SLOT_START,
      end: SLOT_END,
    });
  });

  it("maps a taken window to a typed slot_taken BookingError", async () => {
    // SlotTakenError from the wire layer propagates through the real booking service.
    const client = makeClient(
      {},
      makeBooking(() => Promise.reject(new SlotTakenError())),
    );
    const err = await client
      .book({ serviceCode: "svc-botox", scheduleId: "sched-1", start: SLOT_START }, auth)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BookingError);
    expect((err as BookingError).code).toBe("slot_taken");
  });
});

describe("api-client ⇄ BFF staff contract (real staff service, stubbed FHIR wire)", () => {
  const staffUser = { profileReference: "Practitioner/prac-1", accessToken: "at-staff" };
  const auth = { cookie: "medibun_session=staff-1" };

  const appointmentsBundle = {
    resourceType: "Bundle",
    type: "searchset",
    entry: [
      {
        resource: {
          resourceType: "Appointment",
          id: "appt-1",
          status: "booked",
          created: "2026-07-01T00:00:00.000Z",
          serviceType: [
            {
              coding: [
                { system: "https://medibun.com/fhir/CodeSystem/services", code: "svc-botox" },
              ],
            },
          ],
          start: "2026-07-06T14:00:00.000Z",
          end: "2026-07-06T14:30:00.000Z",
          participant: [
            { actor: { reference: "Patient/pt-1" }, status: "accepted" },
            { actor: { reference: "Practitioner/prac-1" }, status: "accepted" },
          ],
        },
      },
      {
        resource: {
          resourceType: "Patient",
          id: "pt-1",
          name: [{ given: ["Synthia"], family: "Loginsmith" }],
          telecom: [{ system: "email", value: "synthia.login@example.test" }],
        },
      },
      {
        resource: {
          resourceType: "Practitioner",
          id: "prac-1",
          name: [{ given: ["Riley"], family: "Reyes" }],
          extension: [{ url: TIMEZONE_EXTENSION_URL, valueCode: "America/New_York" }],
        },
      },
    ],
  };

  const emptyBundle = { resourceType: "Bundle", type: "searchset" };

  function makeStaffClient(patchResource?: ReturnType<typeof makePatch>) {
    const staff = createStaffService({
      catalog: { listActive: () => Promise.resolve([botoxRow]) },
      userClient: () => ({
        get: (url: string) => {
          if (url.startsWith("fhir/R4/Schedule?")) {
            return Promise.resolve(scheduleBundle);
          }
          if (url.includes("patient=")) {
            return Promise.resolve(emptyBundle); // no priors → first visit
          }
          return Promise.resolve(appointmentsBundle);
        },
        post: () => Promise.reject(new Error("unexpected post")),
        readResource: () => Promise.resolve(appointmentsBundle.entry[0]!.resource as never),
        patchResource: patchResource ?? makePatch(),
      }),
      now: () => NOW,
    });
    const app = createApp({
      log: () => undefined,
      checkMedplum: () => Promise.resolve(true),
      auth: {
        login: () => Promise.resolve({ sessionId: "staff-1" }),
        logout: () => Promise.resolve(),
        getUser: (sessionId) => Promise.resolve(sessionId === "staff-1" ? staffUser : null),
        getMyProfile: () => Promise.resolve(undefined),
        recordAndCheckRateLimit: () => Promise.resolve(false),
        cookieSecure: false,
      },
      staff,
    });
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
      app.request(input, init)) as typeof fetch;
    return createApiClient({ baseUrl: "http://bff.test", fetch: fetchImpl });
  }

  function makePatch() {
    return () =>
      Promise.resolve({
        ...(appointmentsBundle.entry[0]!.resource as object),
        status: "arrived",
      } as never);
  }

  it("round-trips the day sheet DTO (the contract's heart)", async () => {
    const client = makeStaffClient();
    const sheet = await client.getDaySheet(undefined, auth);
    expect(sheet).toEqual({
      date: "2026-07-06",
      days: 1,
      timezone: "America/New_York",
      practitioners: [{ practitionerId: "prac-1", practitionerName: "Riley Reyes" }],
      appointments: [
        {
          id: "appt-1",
          practitionerId: "prac-1",
          patientId: "pt-1",
          patientName: "Synthia Loginsmith",
          patientEmail: "synthia.login@example.test",
          serviceCode: "svc-botox",
          serviceName: "Botox",
          serviceColor: "sage",
          start: "2026-07-06T14:00:00.000Z",
          end: "2026-07-06T14:30:00.000Z",
          status: "scheduled",
          firstVisit: true,
          bookedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
      events: [],
    });
  });

  it("checks in through the workflow endpoint and returns the domain status", async () => {
    const client = makeStaffClient();
    await expect(client.setAppointmentStatus("appt-1", "arrived", auth)).resolves.toEqual({
      id: "appt-1",
      status: "arrived",
    });
  });

  it("maps a signed-out day-sheet request to a typed unauthorized StaffError", async () => {
    const client = makeStaffClient();
    const err = await client.getDaySheet().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaffError);
    expect((err as StaffError).code).toBe("unauthorized");
  });

  it("maps a raced status move to a typed conflict StaffError", async () => {
    const client = makeStaffClient((() =>
      Promise.reject(new StatusConflictError())) as unknown as ReturnType<typeof makePatch>);
    const err = await client
      .setAppointmentStatus("appt-1", "arrived", auth)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaffError);
    expect((err as StaffError).code).toBe("conflict");
  });
});

describe("api-client ⇄ BFF S5.7 contract (real cancel + move-up services, stubbed FHIR wire)", () => {
  const staffUser = { profileReference: "Practitioner/prac-1", accessToken: "at-staff" };
  const auth = { cookie: "medibun_session=staff-1" };
  const SERVICES = "https://medibun.com/fhir/CodeSystem/services";

  const s57Schedules = {
    resourceType: "Bundle",
    type: "searchset",
    entry: [
      {
        resource: {
          resourceType: "Schedule",
          id: "sched-1",
          actor: [{ reference: "Practitioner/prac-1" }],
          serviceType: [{ coding: [{ system: SERVICES, code: "svc-botox" }] }],
        },
      },
      {
        resource: {
          resourceType: "Practitioner",
          id: "prac-1",
          name: [{ given: ["Riley"], family: "Reyes" }],
          extension: [{ url: TIMEZONE_EXTENSION_URL, valueCode: "America/New_York" }],
        },
      },
    ],
  };

  const appointment = (id: string, status: string) => ({
    resourceType: "Appointment",
    id,
    status,
    serviceType: [{ coding: [{ system: SERVICES, code: "svc-botox" }] }],
    start: "2026-07-16T14:00:00.000Z",
    end: "2026-07-16T14:30:00.000Z",
    ...(status === "booked" ? { slot: [{ reference: `Slot/sl-${id}` }] } : {}),
    participant: [
      { actor: { reference: "Patient/pt-1" }, status: "accepted" },
      { actor: { reference: "Practitioner/prac-1" }, status: "accepted" },
    ],
  });

  let db: Awaited<ReturnType<typeof bootTestDb>>;

  beforeAll(async () => {
    db = await bootTestDb();
  }, 60_000);

  beforeEach(async () => {
    await db.delete(dbSchema.moveUpRequests);
  });

  function makeS57Client(resources: Record<string, unknown>) {
    const deleted: string[] = [];
    const userClient = () =>
      ({
        get: (url: string) =>
          Promise.resolve(
            url.startsWith("fhir/R4/Schedule?")
              ? s57Schedules
              : { resourceType: "Bundle", type: "searchset" }, // no busy slots
          ),
        post: () => Promise.reject(new Error("unexpected post")),
        readResource: (type: string, id: string) => Promise.resolve(resources[`${type}/${id}`]),
        patchResource: (_t: string, id: string) => Promise.resolve(resources[`Appointment/${id}`]),
      }) as never;
    const writer = {
      createResource: <T>(resource: T) => Promise.resolve({ ...resource, id: "sl-new" }),
      deleteResource: (resourceType: string, id: string) => {
        deleted.push(`${resourceType}/${id}`);
        return Promise.resolve(undefined);
      },
    } as never;
    const moveUp = createMoveUpService({
      db,
      catalog: {
        getByCode: (code) => Promise.resolve(code === "svc-botox" ? botoxRow : undefined),
      },
      userClient,
    });
    const cancel = createCancelService({
      getFhirClient: () => Promise.resolve(writer),
      userClient,
      countMoveUpMatches: moveUp.countMatches,
    });
    const app = createApp({
      log: () => undefined,
      checkMedplum: () => Promise.resolve(true),
      auth: {
        login: () => Promise.resolve({ sessionId: "staff-1" }),
        logout: () => Promise.resolve(),
        getUser: (sessionId) => Promise.resolve(sessionId === "staff-1" ? staffUser : null),
        getMyProfile: () => Promise.resolve(undefined),
        recordAndCheckRateLimit: () => Promise.resolve(false),
        cookieSecure: false,
      },
      staff: {
        getStaffProfile: () => Promise.resolve(undefined),
        getDaySheet: () => Promise.reject(new Error("unused")),
        setAppointmentStatus: () => Promise.reject(new Error("unused")),
      },
      cancel,
      moveUp,
    });
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
      app.request(input, init)) as typeof fetch;
    return { client: createApiClient({ baseUrl: "http://bff.test", fetch: fetchImpl }), deleted };
  }

  const resources = {
    "Appointment/appt-cancel": appointment("appt-cancel", "booked"),
    "Appointment/appt-held": appointment("appt-held", "booked"),
    "Appointment/appt-restore": appointment("appt-restore", "cancelled"),
    "Patient/pt-1": {
      resourceType: "Patient",
      id: "pt-1",
      name: [{ given: ["Synthia"], family: "Loginsmith" }],
      telecom: [{ system: "phone", value: "555-010-0100" }],
    },
    "Practitioner/prac-1": s57Schedules.entry[1]!.resource,
  };

  it("round-trips the move-up entry DTO: add → list → resolve", async () => {
    const { client } = makeS57Client(resources);
    const entry = await client.addMoveUp(
      { appointmentId: "appt-held", note: "mornings only" },
      auth,
    );
    expect(entry).toMatchObject({
      patientId: "pt-1",
      patientName: "Synthia Loginsmith",
      patientPhone: "555-010-0100",
      appointmentId: "appt-held",
      appointmentStart: "2026-07-16T14:00:00.000Z",
      serviceCode: "svc-botox",
      serviceName: "Botox",
      note: "mornings only",
    });
    await expect(client.listMoveUp(auth)).resolves.toEqual([entry]);
    await client.resolveMoveUp(entry.id, "fulfilled", auth);
    await expect(client.listMoveUp(auth)).resolves.toEqual([]);
  });

  it("cancels end-to-end: coded reason, freed protector slot, live match cue", async () => {
    const { client, deleted } = makeS57Client(resources);
    await client.addMoveUp({ appointmentId: "appt-held" }, auth);
    await expect(client.cancelAppointment("appt-cancel", "patient", auth)).resolves.toEqual({
      id: "appt-cancel",
      status: "cancelled",
      moveUpMatches: 1,
    });
    expect(deleted).toEqual(["Slot/sl-appt-cancel"]);
  });

  it("restores end-to-end (the undo) and re-protects the window", async () => {
    const { client } = makeS57Client(resources);
    await expect(client.restoreAppointment("appt-restore", auth)).resolves.toEqual({
      id: "appt-restore",
      status: "scheduled",
    });
  });
});
