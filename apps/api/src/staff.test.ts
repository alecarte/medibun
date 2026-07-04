import { StatusConflictError } from "@medibun/medplum-backend";
import type { Appointment, Practitioner } from "@medibun/fhir-types";
import { describe, expect, it, vi } from "vitest";

import {
  createStaffService,
  InvalidTransitionError,
  UnknownAppointmentError,
  zonedDayBounds,
  type StaffUserClient,
} from "./staff.js";
import type { ServiceRow } from "./services/catalog.js";

const TZ = "America/New_York";

describe("zonedDayBounds", () => {
  it("bounds an ordinary practice day (EDT, UTC-4)", () => {
    const bounds = zonedDayBounds(new Date("2026-07-04T15:30:00.000Z"), TZ);
    expect(bounds.date).toBe("2026-07-04");
    expect(bounds.start.toISOString()).toBe("2026-07-04T04:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2026-07-05T04:00:00.000Z");
  });

  it("gives the DST fall-back day its full 25 hours (2026-11-01)", () => {
    const bounds = zonedDayBounds(new Date("2026-11-01T12:00:00.000Z"), TZ);
    expect(bounds.start.toISOString()).toBe("2026-11-01T04:00:00.000Z"); // still EDT
    expect(bounds.end.toISOString()).toBe("2026-11-02T05:00:00.000Z"); // now EST
    expect(bounds.end.getTime() - bounds.start.getTime()).toBe(25 * 3600_000);
  });

  it("gives the spring-forward day 23 hours (2026-03-08)", () => {
    const bounds = zonedDayBounds(new Date("2026-03-08T12:00:00.000Z"), TZ);
    expect(bounds.end.getTime() - bounds.start.getTime()).toBe(23 * 3600_000);
  });

  it("handles a day boundary: late UTC evening is already tomorrow in UTC but not locally", () => {
    const bounds = zonedDayBounds(new Date("2026-07-05T01:00:00.000Z"), TZ);
    expect(bounds.date).toBe("2026-07-04");
  });
});

/** Fixtures — synthetic, non-PHI (testing rules). */
const SCHEDULES_URL = /fhir\/R4\/Schedule\?/;
const APPOINTMENTS_URL = /fhir\/R4\/Appointment\?_include/;
const PRIOR_URL = /fhir\/R4\/Appointment\?patient=/;

const practitioner = (id: string, family: string): Practitioner => ({
  resourceType: "Practitioner",
  id,
  name: [{ given: ["Riley"], family }],
  extension: [{ url: "http://hl7.org/fhir/StructureDefinition/timezone", valueCode: TZ }],
});

const appointment = (
  id: string,
  status: Appointment["status"],
  opts?: { serviceCode?: string; created?: string },
): Appointment => ({
  resourceType: "Appointment",
  id,
  status,
  ...(opts?.created ? { created: opts.created } : {}),
  ...(opts?.serviceCode
    ? {
        serviceType: [
          {
            coding: [
              { system: "https://medibun.com/fhir/CodeSystem/services", code: opts.serviceCode },
            ],
          },
        ],
      }
    : {}),
  start: "2026-07-04T14:00:00.000Z",
  end: "2026-07-04T14:30:00.000Z",
  participant: [
    { actor: { reference: "Patient/pt1" }, status: "accepted" },
    { actor: { reference: "Practitioner/pr1" }, status: "accepted" },
  ],
});

const serviceRow = (code: string, name: string): ServiceRow =>
  ({
    id: `${code}-row`,
    code,
    name,
    description: "",
    durationMinutes: 30,
    priceCents: 1000,
    categoryColor: "sage",
    healthcareServiceId: "hs1",
    stripeProductId: null,
    active: true,
  }) as ServiceRow;

function fakeClient(handlers: {
  schedules?: unknown;
  appointments?: unknown;
  priorCount?: number;
  read?: Record<string, unknown>;
  patch?: ReturnType<typeof vi.fn>;
}) {
  const get = vi.fn().mockImplementation((url: string) => {
    if (SCHEDULES_URL.test(url)) {
      return Promise.resolve(handlers.schedules ?? { resourceType: "Bundle", type: "searchset" });
    }
    if (PRIOR_URL.test(url)) {
      return Promise.resolve({
        resourceType: "Bundle",
        type: "searchset",
        entry: Array.from({ length: handlers.priorCount ?? 0 }, () => ({
          resource: appointment("prior", "fulfilled"),
        })),
      });
    }
    if (APPOINTMENTS_URL.test(url)) {
      return Promise.resolve(
        handlers.appointments ?? { resourceType: "Bundle", type: "searchset" },
      );
    }
    throw new Error(`unexpected GET ${url}`);
  });
  const readResource = vi.fn().mockImplementation((type: string, id: string) => {
    const key = `${type}/${id}`;
    if (handlers.read && key in handlers.read) {
      // null = "not found" (readAppointmentById resolves undefined on the real client).
      return Promise.resolve(handlers.read[key] ?? undefined);
    }
    return Promise.reject(new Error(`unexpected read ${key}`));
  });
  const patchResource = handlers.patch ?? vi.fn().mockResolvedValue(appointment("a1", "arrived"));
  const client = { get, post: vi.fn(), readResource, patchResource } as unknown as StaffUserClient;
  return { client, get, readResource, patchResource };
}

const user = { profileReference: "Practitioner/pr1", accessToken: "tok" };

const service = (client: StaffUserClient, rows: ServiceRow[] = [], now = "2026-07-04T15:00:00Z") =>
  createStaffService({
    catalog: { listActive: () => Promise.resolve(rows) },
    userClient: () => client,
    now: () => new Date(now),
  });

describe("getStaffProfile", () => {
  it("resolves the practitioner's display name for a staff principal", async () => {
    const { client } = fakeClient({ read: { "Practitioner/pr1": practitioner("pr1", "Reyes") } });
    await expect(service(client).getStaffProfile(user)).resolves.toEqual({
      id: "pr1",
      name: "Riley Reyes",
    });
  });

  it("resolves undefined for a non-staff principal (patient session)", async () => {
    const { client, readResource } = fakeClient({});
    await expect(
      service(client).getStaffProfile({ profileReference: "Patient/pt1", accessToken: "t" }),
    ).resolves.toBeUndefined();
    expect(readResource).not.toHaveBeenCalled();
  });
});

describe("getDaySheet", () => {
  const schedulesBundle = {
    resourceType: "Bundle",
    type: "searchset",
    entry: [
      {
        resource: {
          resourceType: "Schedule",
          id: "s1",
          actor: [{ reference: "Practitioner/pr1" }],
        },
      },
      { resource: practitioner("pr1", "Reyes") },
    ],
  };
  const appointmentsBundle = {
    resourceType: "Bundle",
    type: "searchset",
    entry: [
      {
        resource: appointment("a1", "booked", {
          serviceCode: "svc-botox",
          created: "2026-07-01T00:00:00Z",
        }),
      },
      { resource: appointment("a2", "cancelled") },
      {
        resource: {
          resourceType: "Patient",
          id: "pt1",
          name: [{ given: ["Synthia"], family: "Loginsmith" }],
          telecom: [
            { system: "phone", value: "555-010-0100" },
            { system: "email", value: "synthia.login@example.test" },
          ],
        },
      },
      { resource: practitioner("pr1", "Reyes") },
    ],
  };

  it("assembles columns, maps statuses, resolves services, and flags first visits", async () => {
    const { client, get } = fakeClient({
      schedules: schedulesBundle,
      appointments: appointmentsBundle,
      priorCount: 0,
    });
    const sheet = await service(client, [serviceRow("svc-botox", "Botox")]).getDaySheet(user);

    expect(sheet.date).toBe("2026-07-04");
    expect(sheet.timezone).toBe(TZ);
    expect(sheet.practitioners).toEqual([
      { practitionerId: "pr1", practitionerName: "Riley Reyes" },
    ]);
    // The cancelled appointment is not a day-sheet row; the booked one maps to scheduled.
    expect(sheet.appointments).toHaveLength(1);
    const row = sheet.appointments[0]!;
    expect(row).toMatchObject({
      id: "a1",
      practitionerId: "pr1",
      patientId: "pt1",
      patientName: "Synthia Loginsmith",
      patientPhone: "555-010-0100",
      patientEmail: "synthia.login@example.test",
      serviceCode: "svc-botox",
      serviceName: "Botox",
      serviceColor: "sage",
      status: "scheduled",
      firstVisit: true,
      bookedAt: "2026-07-01T00:00:00Z",
    });
    // The appointment window is the practice-local day, not a UTC day.
    const apptUrl = get.mock.calls.map((c) => String(c[0])).find((u) => APPOINTMENTS_URL.test(u))!;
    expect(apptUrl).toContain(encodeURIComponent("2026-07-04T04:00:00.000Z"));
  });

  it("marks returning patients (prior appointment exists)", async () => {
    const { client } = fakeClient({
      schedules: schedulesBundle,
      appointments: appointmentsBundle,
      priorCount: 1,
    });
    const sheet = await service(client).getDaySheet(user);
    expect(sheet.appointments[0]!.firstVisit).toBe(false);
  });

  it("adds a column for a practitioner with appointments but no schedule", async () => {
    const { client } = fakeClient({
      schedules: { resourceType: "Bundle", type: "searchset" },
      appointments: appointmentsBundle,
    });
    const sheet = await service(client).getDaySheet(user);
    expect(sheet.practitioners.map((p) => p.practitionerId)).toEqual(["pr1"]);
  });
});

describe("setAppointmentStatus", () => {
  it("test-and-sets a legal transition (check-in: scheduled → arrived)", async () => {
    const patch = vi.fn().mockResolvedValue(appointment("a1", "arrived"));
    const { client } = fakeClient({
      read: { "Appointment/a1": appointment("a1", "booked") },
      patch,
    });
    await expect(service(client).setAppointmentStatus(user, "a1", "arrived")).resolves.toEqual({
      id: "a1",
      status: "arrived",
    });
    expect(patch).toHaveBeenCalledWith("Appointment", "a1", [
      { op: "test", path: "/status", value: "booked" },
      { op: "replace", path: "/status", value: "arrived" },
    ]);
  });

  it("maps the undo (arrived → scheduled) to the FHIR pair (arrived → booked)", async () => {
    const patch = vi.fn().mockResolvedValue(appointment("a1", "booked"));
    const { client } = fakeClient({
      read: { "Appointment/a1": appointment("a1", "arrived") },
      patch,
    });
    await service(client).setAppointmentStatus(user, "a1", "scheduled");
    expect(patch).toHaveBeenCalledWith("Appointment", "a1", [
      { op: "test", path: "/status", value: "arrived" },
      { op: "replace", path: "/status", value: "booked" },
    ]);
  });

  it("rejects an illegal move (scheduled → completed) without writing", async () => {
    const patch = vi.fn();
    const { client } = fakeClient({
      read: { "Appointment/a1": appointment("a1", "booked") },
      patch,
    });
    await expect(
      service(client).setAppointmentStatus(user, "a1", "completed"),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(patch).not.toHaveBeenCalled();
  });

  it("rejects moves on unmanaged statuses (cancelled) without writing", async () => {
    const patch = vi.fn();
    const { client } = fakeClient({
      read: { "Appointment/a1": appointment("a1", "cancelled") },
      patch,
    });
    await expect(
      service(client).setAppointmentStatus(user, "a1", "arrived"),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(patch).not.toHaveBeenCalled();
  });

  it("throws UnknownAppointmentError when the appointment is missing/policy-hidden", async () => {
    const { client } = fakeClient({ read: { "Appointment/nope": null } });
    await expect(
      service(client).setAppointmentStatus(user, "nope", "arrived"),
    ).rejects.toBeInstanceOf(UnknownAppointmentError);
  });

  it("propagates StatusConflictError from a lost test-and-set", async () => {
    const patch = vi.fn().mockRejectedValue(new StatusConflictError());
    const { client } = fakeClient({
      read: { "Appointment/a1": appointment("a1", "booked") },
      patch,
    });
    await expect(
      service(client).setAppointmentStatus(user, "a1", "arrived"),
    ).rejects.toBeInstanceOf(StatusConflictError);
  });
});
