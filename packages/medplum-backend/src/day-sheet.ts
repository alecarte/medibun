import { getStatus, isConflict, isNotFound, OperationOutcomeError } from "@medplum/core";
import type { PatchOperation } from "@medplum/core";
import type { Appointment, Bundle, Patient, Practitioner } from "@medplum/fhirtypes";

import { SessionExpiredError } from "./patients.js";
import { bundleResources, schedulesWithActors } from "./scheduling.js";
import type { FhirOpsClient, ScheduleWithActor } from "./scheduling.js";

/**
 * Staff day-sheet reads + the appointment-status write (S5). Every function takes the
 * CALLER's client: the BFF passes the staff user's own session client, so Medplum
 * AccessPolicy enforcement and AuditEvent attribution are inherited by construction —
 * never re-implemented here (docs/AUTH.md "attribution end to end").
 */

/** Medplum denied the caller's principal (403) — the AccessPolicy speaking, not a bug. */
export class ForbiddenError extends Error {
  constructor() {
    super("forbidden for this principal");
    this.name = "ForbiddenError";
  }
}

/** The status test-and-set lost: the appointment changed under us (another station). */
export class StatusConflictError extends Error {
  constructor() {
    super("appointment status changed concurrently");
    this.name = "StatusConflictError";
  }
}

/** Map end-user-principal auth rejections to typed errors; rethrow everything else. */
function rethrowAuth(err: unknown): never {
  if (err instanceof OperationOutcomeError) {
    const status = getStatus(err.outcome);
    if (status === 401) {
      throw new SessionExpiredError();
    }
    if (status === 403) {
      throw new ForbiddenError();
    }
  }
  throw err;
}

/** Every Schedule (with its Practitioner actor) the caller's policy lets them see. */
export async function listSchedules(client: FhirOpsClient): Promise<ScheduleWithActor[]> {
  const params = new URLSearchParams({ _include: "Schedule:actor", _count: "1000" });
  try {
    return schedulesWithActors((await client.get(`fhir/R4/Schedule?${params}`)) as Bundle);
  } catch (err) {
    rethrowAuth(err);
  }
}

export type DayAppointments = {
  readonly appointments: Appointment[];
  /** Included participant actors, keyed by reference ("Patient/id", "Practitioner/id"). */
  readonly patients: Map<string, Patient>;
  readonly practitioners: Map<string, Practitioner>;
};

/** Appointments starting in [start, end) with their participant actors included. */
export async function listDayAppointments(
  client: FhirOpsClient,
  window: { readonly start: string; readonly end: string },
): Promise<DayAppointments> {
  const params = new URLSearchParams({
    _include: "Appointment:actor",
    _count: "1000",
    _sort: "date",
  });
  params.append("date", `ge${window.start}`);
  params.append("date", `lt${window.end}`);
  let bundle: Bundle;
  try {
    bundle = (await client.get(`fhir/R4/Appointment?${params}`)) as Bundle;
  } catch (err) {
    rethrowAuth(err);
  }
  const resources = bundleResources(bundle);
  return {
    appointments: resources.filter(
      (r): r is Appointment => r.resourceType === "Appointment" && Boolean(r.id),
    ),
    patients: new Map(
      resources
        .filter((r): r is Patient => r.resourceType === "Patient" && Boolean(r.id))
        .map((p) => [`Patient/${p.id}`, p]),
    ),
    practitioners: new Map(
      resources
        .filter((r): r is Practitioner => r.resourceType === "Practitioner" && Boolean(r.id))
        .map((p) => [`Practitioner/${p.id}`, p]),
    ),
  };
}

/** Whether the patient has any appointment before `before` (the new-patient signal,
 *  inverted). Cancelled / entered-in-error bookings don't make someone a known face. */
export async function hasAppointmentBefore(
  client: FhirOpsClient,
  patientReference: string,
  before: string,
): Promise<boolean> {
  const params = new URLSearchParams({
    patient: patientReference,
    date: `lt${before}`,
    _count: "1",
  });
  params.append("status:not", "cancelled");
  params.append("status:not", "entered-in-error");
  try {
    const bundle = (await client.get(`fhir/R4/Appointment?${params}`)) as Bundle;
    return (bundle.entry ?? []).length > 0;
  } catch (err) {
    rethrowAuth(err);
  }
}

/** The slice of MedplumClient the by-id reads need (injectable for tests). A single
 *  union signature — two overloads defeat structural matching against the SDK client. */
export type DaySheetReader = {
  readResource: (
    resourceType: "Appointment" | "Practitioner",
    id: string,
  ) => Promise<Appointment | Practitioner>;
};

/** Read a Practitioner as the CALLER (staff read their own profile). Undefined on
 *  not-found; SessionExpiredError / ForbiddenError on auth rejections. */
export async function readPractitionerById(
  client: DaySheetReader,
  id: string,
): Promise<Practitioner | undefined> {
  try {
    return (await client.readResource("Practitioner", id)) as Practitioner;
  } catch (err) {
    if (err instanceof OperationOutcomeError && isNotFound(err.outcome)) {
      return undefined;
    }
    rethrowAuth(err);
  }
}

/** Read an Appointment as the CALLER. Undefined on not-found (or policy-hidden). */
export async function readAppointmentById(
  client: DaySheetReader,
  id: string,
): Promise<Appointment | undefined> {
  try {
    return (await client.readResource("Appointment", id)) as Appointment;
  } catch (err) {
    if (err instanceof OperationOutcomeError && isNotFound(err.outcome)) {
      return undefined;
    }
    rethrowAuth(err);
  }
}

/** The slice of MedplumClient the status write needs (injectable for tests). */
export type AppointmentPatcher = {
  patchResource(
    resourceType: "Appointment",
    id: string,
    operations: PatchOperation[],
  ): Promise<Appointment>;
};

/**
 * Test-and-set the appointment status: the JSONPatch `test` op makes the write atomic
 * against another station changing the status between our read and write — the losing
 * writer gets StatusConflictError and the client refetches truth instead of clobbering.
 */
export async function updateAppointmentStatus(
  client: AppointmentPatcher,
  opts: {
    readonly id: string;
    readonly from: NonNullable<Appointment["status"]>;
    readonly to: NonNullable<Appointment["status"]>;
  },
): Promise<Appointment> {
  try {
    return await client.patchResource("Appointment", opts.id, [
      { op: "test", path: "/status", value: opts.from },
      { op: "replace", path: "/status", value: opts.to },
    ]);
  } catch (err) {
    if (err instanceof OperationOutcomeError) {
      const status = getStatus(err.outcome);
      // A failed `test` op comes back as a client-error outcome (400/409/412 across
      // FHIR servers) — all mean "the status moved under us", never a server fault.
      if (isConflict(err.outcome) || status === 400 || status === 412) {
        throw new StatusConflictError();
      }
    }
    rethrowAuth(err);
  }
}
