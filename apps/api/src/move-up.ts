import {
  MAX_MOVE_UP_NOTE_LENGTH,
  type AddMoveUpRequest,
  type MoveUpEntry,
  type MoveUpResolution,
} from "@medibun/api-client";
import {
  ForbiddenError,
  isInternalEvent,
  readAppointmentById,
  readPatientIfVisible,
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
  assertScheduled,
  patientParticipant,
  telecomValue,
  UnknownAppointmentError,
  type SessionUser,
} from "./staff.js";
import type { ServiceCatalog, ServiceRow } from "./services/catalog.js";

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

/** Per-call memo for the row-resolution reads, so repeat ids cost one read each. */
type ResolveCaches = {
  patients: Map<string, Patient | undefined>;
  practitioners: Map<string, Practitioner | undefined>;
  appointments: Map<string, Appointment | undefined>;
  services: Map<string, ServiceRow | undefined>;
};

const emptyCaches = (): ResolveCaches => ({
  patients: new Map(),
  practitioners: new Map(),
  appointments: new Map(),
  services: new Map(),
});

/** A read whose POLICY DENIAL degrades to undefined, per row — one resource the
 *  caller can't see must render as missing ("Unknown"), never abort the whole
 *  list or masquerade as a session problem (review finding, 2026-07-09). A real
 *  401 (SessionExpiredError) still propagates: the token is dead for every row. */
async function visible<T>(read: () => Promise<T | undefined>): Promise<T | undefined> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return undefined;
    }
    throw err;
  }
}

/** Memoized read-through. */
async function cached<T>(
  cache: Map<string, T | undefined>,
  key: string,
  read: () => Promise<T | undefined>,
): Promise<T | undefined> {
  if (!cache.has(key)) {
    cache.set(key, await read());
  }
  return cache.get(key);
}

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
  /** Resolve one stored row against FHIR + the catalog. The three FHIR reads and the
   *  catalog read are independent — run together. Not-founds AND policy denials
   *  degrade field by field (a hidden or since-deleted resource must not brick the
   *  panel); only a dead token (401) aborts, via the route's mapping. */
  const toEntry = async (
    client: MoveUpUserClient,
    row: MoveUpRow,
    caches: ResolveCaches,
  ): Promise<MoveUpEntry> => {
    const [patient, appointment, practitioner, service] = await Promise.all([
      cached(caches.patients, row.patientId, () =>
        visible(() => readPatientIfVisible(client, row.patientId)),
      ),
      cached(caches.appointments, row.appointmentId, () =>
        visible(() => readAppointmentById(client, row.appointmentId)),
      ),
      row.practitionerId
        ? cached(caches.practitioners, row.practitionerId, () =>
            visible(() => readPractitionerById(client, row.practitionerId!)),
          )
        : Promise.resolve(undefined),
      cached(caches.services, row.serviceCode, () => deps.catalog.getByCode(row.serviceCode)),
    ]);
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
      const caches = emptyCaches();
      // Rows resolve sequentially (each row's reads run in parallel inside toEntry);
      // the caches dedupe repeat ids. The list is desk-sized — no batching machinery.
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
      assertScheduled(appointment);
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
      // Resolve EVERYTHING the response needs BEFORE the insert: a read that fails
      // after the commit would report "couldn't add" for a row that WAS added — and
      // the retry would then 409 as a duplicate (review finding, 2026-07-09).
      const [patient, service] = await Promise.all([
        readPatientIfVisible(client, patientId),
        deps.catalog.getByCode(serviceCode),
      ]);

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
      const caches = emptyCaches();
      caches.patients.set(patientId, patient);
      caches.appointments.set(request.appointmentId, appointment);
      caches.services.set(serviceCode, service);
      if (request.practitionerId) {
        caches.practitioners.set(request.practitionerId, practitioner);
      }
      return toEntry(client, row, caches);
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
