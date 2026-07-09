import {
  INTERNAL_EVENT_TYPES,
  isValidDateString,
  isValidWallTime,
  type CreateInternalEventRequest,
  type InternalEvent,
  type InternalEventType,
} from "@medibun/api-client";
import {
  createInternalEvent,
  deleteInternalEvent,
  isInternalEvent,
  listSchedules,
  practiceTimezone,
  readAppointmentById,
  type DaySheetReader,
  type FhirOpsClient,
  type ResourceWriter,
} from "@medibun/medplum-backend";

import { dayBoundsFor, zonedInstant, type SessionUser } from "./staff.js";

/**
 * Internal events (S5c): day off, staff meeting, misc time block. Split principals
 * (security-review remediation 2026-07-06): READS RUN AS THE CALLER (their Medplum
 * token — the org-parameterized AccessPolicy scopes which appointments/schedules they
 * can anchor an event to, and the FHIR AuditEvent for the delete-probe read names the
 * real staff user); only the WRITES run under the BFF service client (decided
 * 2026-07-06 — staff Slot access is deliberately readonly, and the busy-unavailable
 * Slots that make an event block $find need Slot writes; same "via BFF" pattern and
 * attribution tradeoff as S4 booking). No PHI anywhere on this path: no patient
 * participates, and titles are non-PHI by rule (DATA_MODEL.md).
 */

/** The request failed validation — wrong shape, window, or unknown practitioner. */
export class InvalidEventRequestError extends Error {
  constructor() {
    super("invalid internal-event request");
    this.name = "InvalidEventRequestError";
  }
}

/** No such internal event. Patient appointments answer this too — through the events
 *  path they are indistinguishable from nothing (never confirm they exist). */
export class UnknownEventError extends Error {
  constructor() {
    super("internal event not found");
    this.name = "UnknownEventError";
  }
}

/** Reads run as the CALLER — their AccessPolicy is the scoping line. */
export type EventsUserClient = FhirOpsClient & DaySheetReader;

/** Writes run under the service client (Slot writes; staff Slot access is readonly). */
export type EventsWriter = ResourceWriter;

export type EventsService = {
  readonly createEvent: (
    user: SessionUser,
    request: CreateInternalEventRequest,
  ) => Promise<InternalEvent>;
  readonly deleteEvent: (user: SessionUser, eventId: string) => Promise<void>;
};

const MAX_TITLE_LENGTH = 80;

export function createEventsService(deps: {
  /** The service client — WRITES ONLY. */
  readonly getFhirClient: () => Promise<EventsWriter>;
  /** A Medplum client authenticated with the GIVEN access token (the end user's). */
  readonly userClient: (accessToken: string) => EventsUserClient;
}): EventsService {
  return {
    async createEvent(user, request) {
      const type = INTERNAL_EVENT_TYPES.find((t) => t === request.type);
      const ids = Array.isArray(request.practitionerIds)
        ? [...new Set(request.practitionerIds)]
        : [];
      if (
        !type ||
        ids.length === 0 ||
        !ids.every((id) => typeof id === "string" && id.length > 0) ||
        // A block is per-practitioner; only meetings span several.
        (type !== "meeting" && ids.length !== 1)
      ) {
        throw new InvalidEventRequestError();
      }
      if (request.title !== undefined && typeof request.title !== "string") {
        throw new InvalidEventRequestError();
      }
      const title = request.title?.trim() || undefined;
      if (title !== undefined && title.length > MAX_TITLE_LENGTH) {
        throw new InvalidEventRequestError();
      }

      if (!request.date || !isValidDateString(request.date)) {
        throw new InvalidEventRequestError();
      }
      if (request.allDay !== undefined && typeof request.allDay !== "boolean") {
        throw new InvalidEventRequestError();
      }
      // Not a category: ANY event can be all-day (a whole practice-local day) or timed
      // ("HH:mm" wall times — half-days and any other span). Amendment, Alec 2026-07-06.
      const allDay = request.allDay === true;
      if (
        !allDay &&
        (typeof request.startTime !== "string" ||
          typeof request.endTime !== "string" ||
          !isValidWallTime(request.startTime) ||
          !isValidWallTime(request.endTime) ||
          request.endTime <= request.startTime)
      ) {
        throw new InvalidEventRequestError();
      }

      // Schedules give us both the practice timezone (instant derivation) and each
      // practitioner's blockable schedules — read AS THE CALLER, so their policy
      // decides which practitioners' time they can block (org affinity rides the same
      // operational-read scoping tracked pre-second-tenant in DATA_MODEL.md).
      const schedules = await listSchedules(deps.userClient(user.accessToken));
      const timezone = practiceTimezone(schedules) ?? "UTC";

      // The BFF owns ALL wall-time → instant math (DST-safe), same as the day bounds.
      // These windows are the LONGEST blocks the system mints (an all-day event on a
      // DST fall-back day is 25h) — windowIsFree's MAX_BLOCK_MS conflict-scan bound
      // depends on that; a future multi-day block MUST widen it (test pins the tie).
      const bounds = dayBoundsFor(request.date, timezone);
      const start = allDay
        ? bounds.start.toISOString()
        : zonedInstant(request.date, request.startTime!, timezone).toISOString();
      const end = allDay
        ? bounds.end.toISOString()
        : zonedInstant(request.date, request.endTime!, timezone).toISOString();

      // Block EVERY schedule the chosen practitioners own — a practitioner has one
      // Schedule per service, and $find fans out over all of them. A slot outside a
      // schedule's availability is harmless; a missed schedule is a bookable hole.
      const scheduleReferences: string[] = [];
      for (const id of ids) {
        const own = schedules.filter(
          ({ schedule }) => schedule.actor?.[0]?.reference === `Practitioner/${id}`,
        );
        if (own.length === 0) {
          // Unknown practitioner (or one with nothing bookable to block) — refuse
          // rather than create an event that doesn't actually protect the time.
          throw new InvalidEventRequestError();
        }
        scheduleReferences.push(...own.map(({ schedule }) => `Schedule/${schedule.id}`));
      }

      const appointment = await createInternalEvent(await deps.getFhirClient(), {
        code: type,
        ...(title !== undefined ? { title } : {}),
        practitionerReferences: ids.map((id) => `Practitioner/${id}`),
        scheduleReferences,
        start,
        end,
      });
      return {
        id: appointment.id!,
        type: type as InternalEventType,
        ...(title !== undefined ? { title } : {}),
        practitionerIds: ids,
        start,
        end,
      };
    },

    async deleteEvent(user, eventId) {
      // The probe read runs AS THE CALLER: their org-compartment Appointment policy
      // hides other tenants' events (which then 404 below like unknown ids), and the
      // FHIR AuditEvent for the read names the real staff user, not the service client.
      const appointment = await readAppointmentById(deps.userClient(user.accessToken), eventId);
      // Not found and not-an-event answer identically: patient appointments must be
      // untouchable AND unenumerable through this endpoint.
      if (!appointment || !isInternalEvent(appointment)) {
        throw new UnknownEventError();
      }
      await deleteInternalEvent(await deps.getFhirClient(), appointment);
    },
  };
}
