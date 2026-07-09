import type { Appointment, Patient, Practitioner } from "@medibun/fhir-types";
import { ForbiddenError } from "@medibun/medplum-backend";
import type { drizzle } from "drizzle-orm/pglite";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "./db/schema.js";
import { bootTestDb } from "./db/test-db.js";
import {
  createMoveUpService,
  DuplicateMoveUpError,
  InvalidMoveUpRequestError,
  UnknownMoveUpEntryError,
  type MoveUpService,
  type MoveUpUserClient,
} from "./move-up.js";
import { InvalidTransitionError, UnknownAppointmentError } from "./staff.js";

const SERVICES = "https://medibun.com/fhir/CodeSystem/services";

const patient: Patient = {
  resourceType: "Patient",
  id: "pt1",
  name: [{ given: ["Synthia"], family: "Loginsmith" }],
  telecom: [{ system: "phone", value: "555-010-0100" }],
};

const practitioner: Practitioner = {
  resourceType: "Practitioner",
  id: "pr1",
  name: [{ given: ["Riley"], family: "Reyes" }],
};

const booking = (id: string, overrides?: Partial<Appointment>): Appointment => ({
  resourceType: "Appointment",
  id,
  status: "booked",
  serviceType: [{ coding: [{ system: SERVICES, code: "svc-botox" }] }],
  start: "2026-07-16T18:00:00.000Z",
  end: "2026-07-16T18:30:00.000Z",
  participant: [
    { actor: { reference: "Patient/pt1" }, status: "accepted" },
    { actor: { reference: "Practitioner/pr1" }, status: "accepted" },
  ],
  ...overrides,
});

/** Canned FHIR reads keyed by "Type/id"; unknown ids resolve undefined (not-found). */
function fakeUserClient(resources: Record<string, unknown>): MoveUpUserClient {
  return {
    readResource: (type: string, id: string) => Promise.resolve(resources[`${type}/${id}`]),
  } as unknown as MoveUpUserClient;
}

const catalog = {
  getByCode: (code: string) =>
    Promise.resolve(code === "svc-botox" ? ({ name: "Botox" } as { name: string }) : undefined),
} as unknown as Parameters<typeof createMoveUpService>[0]["catalog"];

let db: ReturnType<typeof drizzle>;

// One PGlite boot per file (shared helper); explicit budget for cold CI runners.
beforeAll(async () => {
  db = await bootTestDb();
}, 60_000);

const user = { profileReference: "Practitioner/pr-staff", accessToken: "tok" };

const defaultResources = {
  "Patient/pt1": patient,
  "Practitioner/pr1": practitioner,
  "Appointment/a1": booking("a1"),
  "Appointment/a2": booking("a2"),
};

function service(resources: Record<string, unknown> = defaultResources): MoveUpService {
  return createMoveUpService({ db, catalog, userClient: () => fakeUserClient(resources) });
}

beforeEach(async () => {
  await db.delete(schema.moveUpRequests);
});

describe("addMoveUp", () => {
  it("stores ids only and returns the FHIR-resolved entry", async () => {
    const entry = await service().add(user, {
      appointmentId: "a1",
      practitionerId: "pr1",
      note: "  mornings only  ",
    });
    expect(entry).toMatchObject({
      patientId: "pt1",
      patientName: "Synthia Loginsmith",
      patientPhone: "555-010-0100",
      appointmentId: "a1",
      appointmentStart: "2026-07-16T18:00:00.000Z",
      serviceCode: "svc-botox",
      serviceName: "Botox",
      practitionerId: "pr1",
      practitionerName: "Riley Reyes",
      note: "mornings only",
    });
    // The row itself carries no names/phones — ids only (PHI stays in Medplum).
    const rows = await db.select().from(schema.moveUpRequests);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      patientId: "pt1",
      appointmentId: "a1",
      serviceCode: "svc-botox",
      practitionerId: "pr1",
      note: "mornings only",
      status: "waiting",
    });
    expect(JSON.stringify(rows[0])).not.toContain("Loginsmith");
    expect(JSON.stringify(rows[0])).not.toContain("555-010-0100");
  });

  it("refuses a second waiting entry for the same appointment", async () => {
    const s = service();
    await s.add(user, { appointmentId: "a1" });
    await expect(s.add(user, { appointmentId: "a1" })).rejects.toBeInstanceOf(DuplicateMoveUpError);
  });

  it("allows a new entry after the earlier one resolved", async () => {
    const s = service();
    const first = await s.add(user, { appointmentId: "a1" });
    await s.resolve(first.id, "removed");
    await expect(s.add(user, { appointmentId: "a1" })).resolves.toMatchObject({
      appointmentId: "a1",
    });
  });

  it("answers unknown ids and internal events identically (not found)", async () => {
    await expect(service().add(user, { appointmentId: "nope" })).rejects.toBeInstanceOf(
      UnknownAppointmentError,
    );
    const event = booking("a1", {
      appointmentType: {
        coding: [
          { system: "https://medibun.com/fhir/CodeSystem/internal-events", code: "meeting" },
        ],
      },
      participant: [{ actor: { reference: "Practitioner/pr1" }, status: "accepted" }],
    });
    await expect(
      service({ ...defaultResources, "Appointment/a1": event }).add(user, {
        appointmentId: "a1",
      }),
    ).rejects.toBeInstanceOf(UnknownAppointmentError);
  });

  it("refuses non-scheduled appointments (nothing to move up)", async () => {
    await expect(
      service({ ...defaultResources, "Appointment/a1": booking("a1", { status: "arrived" }) }).add(
        user,
        { appointmentId: "a1" },
      ),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("commits NO row when a pre-insert read fails (no phantom 'couldn't add' rows)", async () => {
    // A transient FHIR failure on the patient read must fail the add BEFORE the
    // insert — a committed-then-errored add would show "couldn't add" and then 409
    // the retry as a duplicate (review finding, 2026-07-09).
    const flaky = createMoveUpService({
      db,
      catalog,
      userClient: () =>
        ({
          readResource: (type: string, id: string) =>
            type === "Patient"
              ? Promise.reject(new Error("connection refused"))
              : Promise.resolve(defaultResources[`${type}/${id}` as keyof typeof defaultResources]),
        }) as unknown as MoveUpUserClient,
    });
    await expect(flaky.add(user, { appointmentId: "a1" })).rejects.toThrow("connection refused");
    await expect(db.select().from(schema.moveUpRequests)).resolves.toEqual([]);
  });

  it("bounds the note and requires a known practitioner preference", async () => {
    await expect(
      service().add(user, { appointmentId: "a1", note: "x".repeat(121) }),
    ).rejects.toBeInstanceOf(InvalidMoveUpRequestError);
    await expect(
      service().add(user, { appointmentId: "a1", practitionerId: "pr-unknown" }),
    ).rejects.toBeInstanceOf(InvalidMoveUpRequestError);
  });
});

describe("listMoveUp", () => {
  it("lists waiting entries oldest first, resolved against FHIR", async () => {
    const s = service();
    await s.add(user, { appointmentId: "a1" });
    await s.add(user, { appointmentId: "a2", note: "any provider" });
    const entries = await s.list(user);
    expect(entries.map((e) => e.appointmentId)).toEqual(["a1", "a2"]);
    expect(entries[0]).toMatchObject({
      patientName: "Synthia Loginsmith",
      serviceName: "Botox",
    });
  });

  it("degrades a since-deleted patient/appointment to Unknown instead of failing", async () => {
    const s = service();
    await s.add(user, { appointmentId: "a1" });
    const afterDeletion = service({ "Practitioner/pr1": practitioner });
    const entries = await afterDeletion.list(user);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ patientName: "Unknown" });
    expect(entries[0]!.appointmentStart).toBeUndefined();
  });

  it("degrades a POLICY-HIDDEN row field-by-field — one 403 never aborts the list", async () => {
    const s = service();
    await s.add(user, { appointmentId: "a1" });
    await s.add(user, { appointmentId: "a2" });
    // The caller's policy refuses a1's reads (ForbiddenError is what the
    // medplum-backend read helpers map a FHIR 403 to); a2 stays readable.
    const denying = createMoveUpService({
      db,
      catalog,
      userClient: () =>
        ({
          readResource: (type: string, id: string) =>
            `${type}/${id}` === "Appointment/a1"
              ? Promise.reject(new ForbiddenError())
              : Promise.resolve(defaultResources[`${type}/${id}` as keyof typeof defaultResources]),
        }) as unknown as MoveUpUserClient,
    });
    const entries = await denying.list(user);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.appointmentStart).toBeUndefined(); // hidden appointment degrades
    expect(entries[1]).toMatchObject({ patientName: "Synthia Loginsmith" }); // a2 intact
  });

  it("resolves each service code once per list, not once per row", async () => {
    const getByCode = vi.fn((code: string) =>
      Promise.resolve(code === "svc-botox" ? ({ name: "Botox" } as { name: string }) : undefined),
    );
    const counting = createMoveUpService({
      db,
      catalog: { getByCode } as unknown as Parameters<typeof createMoveUpService>[0]["catalog"],
      userClient: () => fakeUserClient(defaultResources),
    });
    await counting.add(user, { appointmentId: "a1" });
    await counting.add(user, { appointmentId: "a2" });
    getByCode.mockClear();
    await counting.list(user);
    expect(getByCode).toHaveBeenCalledTimes(1); // both rows share svc-botox
  });

  it("hides resolved entries", async () => {
    const s = service();
    const entry = await s.add(user, { appointmentId: "a1" });
    await s.resolve(entry.id, "fulfilled");
    await expect(s.list(user)).resolves.toEqual([]);
  });
});

describe("resolveMoveUp", () => {
  it("marks a waiting entry and refuses a second resolution", async () => {
    const s = service();
    const entry = await s.add(user, { appointmentId: "a1" });
    await expect(s.resolve(entry.id, "fulfilled")).resolves.toEqual({
      id: entry.id,
      status: "fulfilled",
    });
    await expect(s.resolve(entry.id, "removed")).rejects.toBeInstanceOf(UnknownMoveUpEntryError);
  });

  it("reads a malformed id as not-found, never a 500", async () => {
    await expect(service().resolve("not-a-uuid", "removed")).rejects.toBeInstanceOf(
      UnknownMoveUpEntryError,
    );
  });
});

describe("countMatches", () => {
  it("counts waiting same-service entries whose practitioner preference fits", async () => {
    const s = service();
    await s.add(user, { appointmentId: "a1" }); // any practitioner
    await s.add(user, { appointmentId: "a2", practitionerId: "pr1" }); // pinned to pr1
    await expect(s.countMatches("svc-botox", "pr1", "other")).resolves.toBe(2);
    // A different freed column: the pr1-pinned entry no longer fits.
    await expect(s.countMatches("svc-botox", "pr9", "other")).resolves.toBe(1);
    await expect(s.countMatches("svc-lip-filler", "pr1", "other")).resolves.toBe(0);
    await expect(s.countMatches(undefined, "pr1", "other")).resolves.toBe(0);
  });

  it("never counts the cancelled appointment's own entry", async () => {
    const s = service();
    await s.add(user, { appointmentId: "a1" });
    await expect(s.countMatches("svc-botox", "pr1", "a1")).resolves.toBe(0);
  });

  it("ignores resolved entries", async () => {
    const s = service();
    const entry = await s.add(user, { appointmentId: "a1" });
    await s.resolve(entry.id, "removed");
    await expect(s.countMatches("svc-botox", "pr1", "other")).resolves.toBe(0);
  });
});
