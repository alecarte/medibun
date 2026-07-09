import {
  MAX_MOVE_UP_NOTE_LENGTH,
  type AddMoveUpRequest,
  type MoveUpEntry,
  type MoveUpResolution,
} from "@medibun/api-client";
import {
  isInternalEvent,
  readAppointmentById,
  readPatientById,
  readPractitionerById,
  serviceCodeOf,
  type DaySheetReader,
  type PatientReader,
} from "@medibun/medplum-backend";
import type { Appointment, Patient, Practitioner } from "@medibun/fhir-types";
import { and, asc, count, eq, isNull, ne, or } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { moveUpRequests } from "./db/schema.js";
import { humanNameDisplay } from "./patients.js";
import {
  InvalidTransitionError,
  patientParticipant,
  telecomValue,
  UnknownAppointmentError,
  type SessionUser,
} from "./staff.js";
import type { ServiceCatalog } from "./services/catalog.js";

/**
 * The move-up list (S5.7): the desk-worked cancellation-backfill waitlist. Experience
 * data — the table stores IDS ONLY (patient/appointment/practitioner); names, phones,
 * and appointment times are resolved live from FHIR AS THE CALLER on every read, so
 * their org-scoped AccessPolicy decides what resolves and the reads audit-attribute to
 * the real staff user. Nothing PHI-shaped ever enters the experience DB.
 *
 * Fulfilling an entry is NOT this module's job: the desk reschedules the patient's
 * existing appointment earlier (the S5.5 machinery) and then marks the entry fulfilled
 * here. Phase-2 seam: a Bot on Appointment?status=cancelled works `waiting` rows
 * automatically — the status/resolvedAt columns are that seam.
 */

/** Bad add request: malformed fields, unknown practitioner preference, or an
 *  appointment without our service code. */
export class InvalidMoveUpRequestError extends Error {
  constructor() {
    super("invalid move-up request");
    this.name = "InvalidMoveUpRequestError";
  }
}

/** The appointment already has a waiting entry (the partial unique index spoke). */
export class DuplicateMoveUpError extends Error {
  constructor() {
    super("appointment already has a waiting move-up entry");
    this.name = "DuplicateMoveUpError";
  }
}

/** No waiting entry with that id — unknown and already-resolved answer identically. */
export class UnknownMoveUpEntryError extends Error {
  constructor() {
    super("move-up entry not found");
    this.name = "UnknownMoveUpEntryError";
  }
}

// Same driver-agnostic shape as catalog.ts: node-postgres in prod, PGlite in tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<PgQueryResultHKT, any, any>;

/** Reads run as the CALLER — appointment, patient, and practitioner resolution. */
export type MoveUpUserClient = DaySheetReader & PatientReader;

type MoveUpRow = typeof moveUpRequests.$inferSelect;

export type MoveUpService = {
  /** Waiting entries, oldest first (fairness), resolved against FHIR as the caller. */
  readonly list: (user: SessionUser) => Promise<MoveUpEntry[]>;
  /** Puts a SCHEDULED appointment's patient on the list. Throws
   *  InvalidMoveUpRequestError / UnknownAppointmentError / InvalidTransitionError /
   *  DuplicateMoveUpError. */
  readonly add: (user: SessionUser, request: AddMoveUpRequest) => Promise<MoveUpEntry>;
  /** Marks a waiting entry fulfilled or removed. Throws UnknownMoveUpEntryError. */
  readonly resolve: (
    entryId: string,
    resolution: MoveUpResolution,
  ) => Promise<{ id: string; status: MoveUpResolution }>;
  /** Waiting entries the freed window could serve: same service, practitioner
   *  preference absent or equal to the freed column — minus the cancelled
   *  appointment's own entry (its patient isn't a candidate for their own slot).
   *  The post-cancel desk cue; the panel is where staff judge actual fit. */
  readonly countMatches: (
    serviceCode: string | undefined,
    freedPractitionerId: string | undefined,
    excludeAppointmentId: string,
  ) => Promise<number>;
};

/** Reads a bad uuid in the URL as "no such entry" instead of a 500 — the invalid-uuid
 *  Postgres error (22P02) surfaces on the query, sometimes wrapped by the driver. */
function isInvalidUuidError(err: unknown): boolean {
  for (let e = err; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: string }).code === "22P02") {
      return true;
    }
  }
  return false;
}

export function createMoveUpService(deps: {
  readonly db: Db;
  readonly catalog: Pick<ServiceCatalog, "getByCode">;
  /** A Medplum client authenticated with the GIVEN access token (the end user's). */
  readonly userClient: (accessToken: string) => MoveUpUserClient;
}): MoveUpService {
  /** Resolve one stored row against FHIR + the catalog. Not-founds degrade field by
   *  field (a since-deleted patient must not brick the whole panel); auth errors
   *  propagate to the route's 401/403 mapping. */
  const toEntry = async (
    client: MoveUpUserClient,
    row: MoveUpRow,
    caches: {
      patients: Map<string, Patient | undefined>;
      practitioners: Map<string, Practitioner | undefined>;
      appointments: Map<string, Appointment | undefined>;
    },
  ): Promise<MoveUpEntry> => {
    if (!caches.patients.has(row.patientId)) {
      caches.patients.set(row.patientId, await readPatientById(client, row.patientId));
    }
    if (!caches.appointments.has(row.appointmentId)) {
      caches.appointments.set(
        row.appointmentId,
        await readAppointmentById(client, row.appointmentId),
      );
    }
    if (row.practitionerId && !caches.practitioners.has(row.practitionerId)) {
      caches.practitioners.set(
        row.practitionerId,
        await readPractitionerById(client, row.practitionerId),
      );
    }
    const patient = caches.patients.get(row.patientId);
    const appointment = caches.appointments.get(row.appointmentId);
    const practitioner = row.practitionerId
      ? caches.practitioners.get(row.practitionerId)
      : undefined;
    const service = await deps.catalog.getByCode(row.serviceCode);
    const phone = patient && telecomValue(patient, "phone");
    return {
      id: row.id,
      patientId: row.patientId,
      patientName: patient ? humanNameDisplay(patient.name?.[0]) : "Unknown",
      ...(phone ? { patientPhone: phone } : {}),
      appointmentId: row.appointmentId,
      ...(appointment?.start ? { appointmentStart: appointment.start } : {}),
      serviceCode: row.serviceCode,
      ...(service ? { serviceName: service.name } : {}),
      ...(row.practitionerId ? { practitionerId: row.practitionerId } : {}),
      ...(practitioner ? { practitionerName: humanNameDisplay(practitioner.name?.[0]) } : {}),
      ...(row.note ? { note: row.note } : {}),
      createdAt: row.createdAt.toISOString(),
    };
  };

  return {
    async list(user) {
      const rows = await deps.db
        .select()
        .from(moveUpRequests)
        .where(eq(moveUpRequests.status, "waiting"))
        .orderBy(asc(moveUpRequests.createdAt));
      const client = deps.userClient(user.accessToken);
      const caches = {
        patients: new Map<string, Patient | undefined>(),
        practitioners: new Map<string, Practitioner | undefined>(),
        appointments: new Map<string, Appointment | undefined>(),
      };
      // Sequential on purpose: the list is short (a desk works it by phone), and the
      // caches dedupe repeat reads — no need for the day sheet's batching machinery.
      const entries: MoveUpEntry[] = [];
      for (const row of rows) {
        entries.push(await toEntry(client, row, caches));
      }
      return entries;
    },

    async add(user, request) {
      if (
        typeof request.appointmentId !== "string" ||
        request.appointmentId.length === 0 ||
        (request.practitionerId !== undefined &&
          (typeof request.practitionerId !== "string" || request.practitionerId.length === 0)) ||
        (request.note !== undefined && typeof request.note !== "string")
      ) {
        throw new InvalidMoveUpRequestError();
      }
      const note = request.note?.trim() || undefined;
      if (note !== undefined && note.length > MAX_MOVE_UP_NOTE_LENGTH) {
        throw new InvalidMoveUpRequestError();
      }

      const client = deps.userClient(user.accessToken);
      const appointment = await readAppointmentById(client, request.appointmentId);
      // Internal events and unknown ids answer identically (no patient to move up).
      if (!appointment || isInternalEvent(appointment)) {
        throw new UnknownAppointmentError();
      }
      // Scheduled-only: an arrived/roomed patient is in the building; completed /
      // no-show / cancelled have nothing to move up. Same recovery as a stale move.
      if (appointment.status !== "booked") {
        throw new InvalidTransitionError();
      }
      const patientId = patientParticipant(appointment)?.split("/")[1];
      const serviceCode = serviceCodeOf(appointment);
      if (!patientId || !serviceCode) {
        throw new InvalidMoveUpRequestError();
      }
      let practitioner: Practitioner | undefined;
      if (request.practitionerId) {
        practitioner = await readPractitionerById(client, request.practitionerId);
        if (!practitioner) {
          throw new InvalidMoveUpRequestError();
        }
      }

      const inserted = await deps.db
        .insert(moveUpRequests)
        .values({
          patientId,
          appointmentId: request.appointmentId,
          serviceCode,
          practitionerId: request.practitionerId ?? null,
          note: note ?? null,
          status: "waiting",
        })
        .onConflictDoNothing()
        .returning();
      const row = inserted[0];
      if (!row) {
        throw new DuplicateMoveUpError();
      }
      return toEntry(deps.userClient(user.accessToken), row, {
        patients: new Map(),
        practitioners: new Map([[request.practitionerId ?? "", practitioner]]),
        appointments: new Map([[request.appointmentId, appointment]]),
      });
    },

    async resolve(entryId, resolution) {
      let updated: { id: string }[];
      try {
        updated = await deps.db
          .update(moveUpRequests)
          .set({ status: resolution, resolvedAt: new Date() })
          .where(and(eq(moveUpRequests.id, entryId), eq(moveUpRequests.status, "waiting")))
          .returning({ id: moveUpRequests.id });
      } catch (err) {
        if (isInvalidUuidError(err)) {
          throw new UnknownMoveUpEntryError();
        }
        throw err;
      }
      if (!updated[0]) {
        throw new UnknownMoveUpEntryError();
      }
      return { id: updated[0].id, status: resolution };
    },

    async countMatches(serviceCode, freedPractitionerId, excludeAppointmentId) {
      if (!serviceCode) {
        return 0;
      }
      const practitionerFits = freedPractitionerId
        ? or(
            isNull(moveUpRequests.practitionerId),
            eq(moveUpRequests.practitionerId, freedPractitionerId),
          )
        : isNull(moveUpRequests.practitionerId);
      const rows = await deps.db
        .select({ value: count() })
        .from(moveUpRequests)
        .where(
          and(
            eq(moveUpRequests.status, "waiting"),
            eq(moveUpRequests.serviceCode, serviceCode),
            ne(moveUpRequests.appointmentId, excludeAppointmentId),
            practitionerFits,
          ),
        );
      return rows[0]?.value ?? 0;
    },
  };
}
