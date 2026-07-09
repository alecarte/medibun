import {
  isValidDateString,
  isValidWallTime,
  type RescheduleRequest,
  type RescheduledAppointment,
} from "@medibun/api-client";
import {
  findScheduleFor,
  isInternalEvent,
  listSchedules,
  practiceTimezone,
  readAppointmentById,
  resolveBookedSlots,
  rethrowPatchFailure,
  serviceCodeOf,
  StatusConflictError,
  windowIsFree,
  type ResourceWriter,
} from "@medibun/medplum-backend";
import type { Slot } from "@medibun/fhir-types";

import {
  assertScheduled,
  practitionerParticipant,
  UnknownAppointmentError,
  zonedInstant,
  type SessionUser,
  type StaffUserClient,
} from "./staff.js";

/**
 * Drag-to-reschedule (S5.5). No $reschedule exists at our Medplum pin, so a move is:
 * validate the target window is free (busy-Slot overlap check — the S4 "re-derive,
 * never trust the client" defense), create the new busy Slot, RE-CHECK the window
 * with our claim visible (two stations racing onto the same window: one loses here),
 * patch the Appointment with test-and-sets on its CURRENT start and versionId (any
 * concurrent write loses cleanly), then delete the old slot. Split principals, same
 * as S5c events: reads and the Appointment patch run AS THE CALLER (org-scoped
 * policy + audit attribution); only the Slot writes ride the service client (staff
 * Slot access is readonly by design).
 *
 * Deliberately unchecked (S5.5 interview): schedule availability hours — patients
 * can't book off-hours ($find enforces it), but the front desk placing a deliberate
 * off-hours squeeze-in is staff judgment. Conflicts are what matter.
 */

/** Bad reschedule request: malformed date/time, or the target practitioner has no
 *  schedule for the appointment's service. */
export class InvalidRescheduleRequestError extends Error {
  constructor() {
    super("invalid reschedule request");
    this.name = "InvalidRescheduleRequestError";
  }
}

/** Reads + the Appointment patch — the CALLER's own client (the same capability
 *  surface every staff call uses). */
export type RescheduleUserClient = StaffUserClient;

/** Slot writes — the service client (staff Slot access is readonly). */
export type RescheduleWriter = ResourceWriter;

export type RescheduleService = {
  readonly rescheduleAppointment: (
    user: SessionUser,
    appointmentId: string,
    request: RescheduleRequest,
  ) => Promise<RescheduledAppointment>;
};

export function createRescheduleService(deps: {
  readonly getFhirClient: () => Promise<RescheduleWriter>;
  readonly userClient: (accessToken: string) => RescheduleUserClient;
}): RescheduleService {
  return {
    async rescheduleAppointment(user, appointmentId, request) {
      if (
        !request.date ||
        !isValidDateString(request.date) ||
        typeof request.startTime !== "string" ||
        !isValidWallTime(request.startTime) ||
        typeof request.practitionerId !== "string" ||
        request.practitionerId.length === 0
      ) {
        throw new InvalidRescheduleRequestError();
      }

      const caller = deps.userClient(user.accessToken);
      const appointment = await readAppointmentById(caller, appointmentId);
      // Internal events have no reschedule (drag their delete/recreate instead); they
      // and unknown ids answer identically.
      if (!appointment || isInternalEvent(appointment) || !appointment.start || !appointment.end) {
        throw new UnknownAppointmentError();
      }
      // Scheduled-only (S5.5 interview): arrived/roomed patients are in the building;
      // completed/no-show are history. Same client recovery as a stale status move.
      assertScheduled(appointment);
      const serviceCode = serviceCodeOf(appointment);
      if (!serviceCode) {
        // v0 bookings always carry our service code ($book path); without it the
        // target schedule can't be derived.
        throw new InvalidRescheduleRequestError();
      }

      // Schedules read AS THE CALLER: practice timezone + the target's schedule for
      // this service (no schedule for it = can't perform the service = reject).
      const schedules = await listSchedules(caller);
      const timezone = practiceTimezone(schedules);
      if (!timezone) {
        // STRICTER than the display paths (day sheet, $find payload), which tolerate
        // a `?? "UTC"` fallback because a wrong zone only shifts labels: here it
        // would WRITE the move hours off. A missing practice timezone is a stack
        // misconfiguration — hard-fail, never guess (security review, LOW).
        throw new Error("no practice timezone on any schedule actor — cannot derive instants");
      }
      // The SHARED practitioner+service predicate (medplum-backend) — the security
      // control that scopes own-slot resolution; cancel/restore use the same one.
      const scheduleFor = (practitionerId: string) =>
        findScheduleFor(schedules, practitionerId, serviceCode);
      const target = scheduleFor(request.practitionerId);
      if (!target) {
        throw new InvalidRescheduleRequestError();
      }

      const durationMs = Date.parse(appointment.end) - Date.parse(appointment.start);
      const start = zonedInstant(request.date, request.startTime, timezone);
      const end = new Date(start.getTime() + durationMs);
      const window = { start: start.toISOString(), end: end.toISOString() };

      // Own-slot resolution is SCOPED to the appointment's current schedule — the
      // security control that keeps another booking's identical-window protector from
      // being treated as ours (and later deleted). No resolvable current schedule →
      // no fallback, which fails safe: identical windows then read as conflicts.
      const currentPractitionerId = practitionerParticipant(appointment)?.split("/")[1];
      const currentSchedule = currentPractitionerId
        ? scheduleFor(currentPractitionerId)
        : undefined;
      const ownSlots = await resolveBookedSlots(
        caller,
        appointment,
        currentSchedule ? `Schedule/${currentSchedule.schedule.id}` : undefined,
      );
      const free = await windowIsFree(caller, `Schedule/${target.schedule.id}`, window, ownSlots);
      if (!free) {
        // Same wire contract as a lost race: 409, the client refetches and re-decides.
        throw new StatusConflictError();
      }

      // New protector first (same blocking semantics as $book's busy slot), then a
      // RE-CHECK of the window now that our claim is visible: two stations dropping
      // different appointments onto the same open window both pass the pre-check, but
      // only one survives this second look (no serializable $reschedule at our pin —
      // this closes the check-then-act gap to a search round-trip). Then the
      // test-and-set patch; any failure compensates by removing the new slot, so a
      // failed move never leaves the target window blocked.
      const writer = await deps.getFhirClient();
      const newSlot = await writer.createResource<Slot>({
        resourceType: "Slot",
        schedule: { reference: `Schedule/${target.schedule.id}` },
        status: "busy",
        start: window.start,
        end: window.end,
      });
      try {
        const stillFree = await windowIsFree(caller, `Schedule/${target.schedule.id}`, window, [
          ...ownSlots,
          `Slot/${newSlot.id}`,
        ]);
        if (!stillFree) {
          throw new StatusConflictError();
        }
        const participants = (appointment.participant ?? []).map((participant) =>
          participant.actor?.reference?.startsWith("Practitioner/")
            ? { ...participant, actor: { reference: `Practitioner/${request.practitionerId}` } }
            : participant,
        );
        await caller.patchResource("Appointment", appointmentId, [
          // Two tests: /start catches a concurrent time move; /meta/versionId (when
          // the read carried one) catches EVERY concurrent write — without it, a
          // same-start practitioner swap from another station would silently win
          // and strand this move's protector slot (review finding).
          { op: "test", path: "/start", value: appointment.start },
          ...(appointment.meta?.versionId
            ? [{ op: "test" as const, path: "/meta/versionId", value: appointment.meta.versionId }]
            : []),
          { op: "replace", path: "/start", value: window.start },
          { op: "replace", path: "/end", value: window.end },
          // `add` on an object member replaces it when present and creates it when
          // absent (RFC 6902) — `replace` would reject the whole patch on a stack
          // where $book leaves slot[]/participant unset (the live-verify unknown).
          { op: "add", path: "/participant", value: participants },
          { op: "add", path: "/slot", value: [{ reference: `Slot/${newSlot.id}` }] },
        ]);
      } catch (err) {
        await writer.deleteResource("Slot", newSlot.id!).catch(() => {
          console.warn(`reschedule: compensation failed, stranded busy slot Slot/${newSlot.id}`);
        });
        // A lost test op arrives as a raw OperationOutcomeError — map it to the 409
        // wire contract (and auth rejections to 401/403) instead of leaking a 500.
        rethrowPatchFailure(err);
      }
      // Old protectors last: a failure here strands busy slots on the OLD window
      // (availability loss, never a double-booking) — log ids and move on.
      for (const ref of ownSlots) {
        const id = ref.split("/")[1];
        if (id) {
          await writer.deleteResource("Slot", id).catch(() => {
            console.warn(`reschedule: old busy slot not deleted: ${ref}`);
          });
        }
      }

      return {
        id: appointmentId,
        practitionerId: request.practitionerId,
        start: window.start,
        end: window.end,
      };
    },
  };
}
