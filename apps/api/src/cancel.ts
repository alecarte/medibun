import { CANCELLATION_REASONS, type CancellationReason } from "@medibun/api-client";
import {
  findScheduleFor,
  isInternalEvent,
  listSchedules,
  readAppointmentById,
  resolveBookedSlots,
  rethrowPatchFailure,
  serviceCodeOf,
  StatusConflictError,
  windowIsFree,
  type ResourceWriter,
} from "@medibun/medplum-backend";
import type { Appointment, Slot } from "@medibun/fhir-types";

import {
  assertScheduled,
  InvalidTransitionError,
  practitionerParticipant,
  UnknownAppointmentError,
  type SessionUser,
  type StaffUserClient,
} from "./staff.js";

/**
 * Cancel + restore (S5.7). No $cancel exists at our Medplum pin — a cancel is a status
 * write to `cancelled` plus freeing the appointment's protector Slot(s): deleting the
 * busy Slot is exactly what makes $find offer the window again. Restore is the ~10s
 * compensating undo: re-protect the window (which can honestly 409 if it was taken in
 * the meantime — same contract as the S5.5 undo), then re-book the status.
 *
 * Split principals, same as S5.5: the reads and the Appointment patch run AS THE
 * CALLER (org-scoped policy + audit attribution); only the Slot writes ride the
 * service client (staff Slot access is readonly by design).
 *
 * Order is a safety property, both directions: cancel patches the status FIRST and
 * deletes slots after (a partial failure strands a busy Slot — availability loss,
 * logged by id — never a bookable window with a live appointment); restore mints the
 * protector FIRST and patches after (a partial failure strands a busy Slot, never a
 * re-booked appointment whose window someone else can take).
 */

/** Our coded cancellation reasons — `Appointment.cancelationReason` has an example
 *  binding, so a custom CodeSystem is conformant (same argument as services /
 *  internal-events; DATA_MODEL.md). Coded, never free text: no PHI by construction. */
export const CANCELLATION_REASON_SYSTEM = "https://medibun.com/fhir/CodeSystem/cancellation-reason";

/** The reason isn't one of ours — a 400, not a workflow conflict. */
export class InvalidCancelRequestError extends Error {
  constructor() {
    super("invalid cancel request");
    this.name = "InvalidCancelRequestError";
  }
}

/** Reads + the Appointment patch — the CALLER's own client. */
export type CancelUserClient = StaffUserClient;

/** Slot writes — the service client (staff Slot access is readonly). */
export type CancelWriter = ResourceWriter;

export type CancelService = {
  readonly cancelAppointment: (
    user: SessionUser,
    appointmentId: string,
    reason: CancellationReason,
  ) => Promise<{ id: string; status: "cancelled"; moveUpMatches: number }>;
  readonly restoreAppointment: (
    user: SessionUser,
    appointmentId: string,
  ) => Promise<{ id: string; status: "scheduled" }>;
};

export function createCancelService(deps: {
  readonly getFhirClient: () => Promise<CancelWriter>;
  readonly userClient: (accessToken: string) => CancelUserClient;
  /** The move-up match cue (S5.7): waiting entries the freed window could serve. */
  readonly countMoveUpMatches: (
    serviceCode: string | undefined,
    freedPractitionerId: string | undefined,
    excludeAppointmentId: string,
  ) => Promise<number>;
}): CancelService {
  /** The appointment's own schedule reference — scopes slot resolution the same way
   *  S5.5 does, via the SHARED findScheduleFor predicate (the security control
   *  against claiming a foreign protector; one predicate, never forked). */
  const ownScheduleRef = async (
    caller: CancelUserClient,
    appointment: Appointment,
  ): Promise<string | undefined> => {
    const practitionerId = practitionerParticipant(appointment)?.split("/")[1];
    const serviceCode = serviceCodeOf(appointment);
    if (!practitionerId || !serviceCode) {
      return undefined;
    }
    const own = findScheduleFor(await listSchedules(caller), practitionerId, serviceCode);
    return own ? `Schedule/${own.schedule.id}` : undefined;
  };

  return {
    async cancelAppointment(user, appointmentId, reason) {
      if (!CANCELLATION_REASONS.includes(reason)) {
        throw new InvalidCancelRequestError();
      }
      const caller = deps.userClient(user.accessToken);
      const appointment = await readAppointmentById(caller, appointmentId);
      // Internal events have their own delete path; they and unknown ids answer
      // identically (never enumerable through the patient workflow).
      if (!appointment || isInternalEvent(appointment)) {
        throw new UnknownAppointmentError();
      }
      // Scheduled-only (interview decision): arrived/roomed patients are in the
      // building; completed/no-show are history; cancelled is already done.
      assertScheduled(appointment);

      // Resolve the protectors BEFORE the patch (the cancel patch clears slot[]).
      // The schedules read only feeds resolveBookedSlots' window-search FALLBACK —
      // skip that round-trip when the appointment carries its own protector refs
      // (the common $book path; review finding, 2026-07-09).
      const hasSlotRefs = (appointment.slot ?? []).some((s) => s.reference);
      const ownSlots = await resolveBookedSlots(
        caller,
        appointment,
        hasSlotRefs ? undefined : await ownScheduleRef(caller, appointment),
      );

      try {
        await caller.patchResource("Appointment", appointmentId, [
          { op: "test", path: "/status", value: "booked" },
          ...(appointment.meta?.versionId
            ? [{ op: "test" as const, path: "/meta/versionId", value: appointment.meta.versionId }]
            : []),
          { op: "replace", path: "/status", value: "cancelled" },
          // `add` replaces-or-creates (RFC 6902) — the coded reason, never free text.
          {
            op: "add",
            path: "/cancelationReason",
            value: { coding: [{ system: CANCELLATION_REASON_SYSTEM, code: reason }] },
          },
          // Drop the protector refs we're about to delete (dangling refs otherwise).
          ...(appointment.slot ? [{ op: "remove" as const, path: "/slot" }] : []),
        ]);
      } catch (err) {
        rethrowPatchFailure(err);
      }

      // Slots AFTER the status write: a failure here strands a busy Slot (the window
      // stays blocked — availability loss, ids logged, never PHI), which is the safe
      // direction; deleting first could leave a bookable window with a live booking.
      const writer = await deps.getFhirClient();
      for (const ref of ownSlots) {
        const id = ref.split("/")[1];
        if (id) {
          await writer.deleteResource("Slot", id).catch(() => {
            console.warn(`cancel: protector slot not deleted: ${ref}`);
          });
        }
      }

      return {
        id: appointmentId,
        status: "cancelled",
        moveUpMatches: await deps.countMoveUpMatches(
          serviceCodeOf(appointment),
          practitionerParticipant(appointment)?.split("/")[1],
          appointmentId,
        ),
      };
    },

    async restoreAppointment(user, appointmentId) {
      const caller = deps.userClient(user.accessToken);
      const appointment = await readAppointmentById(caller, appointmentId);
      if (!appointment || isInternalEvent(appointment) || !appointment.start || !appointment.end) {
        throw new UnknownAppointmentError();
      }
      // Only a cancelled appointment restores — anything else moved under the undo.
      if (appointment.status !== "cancelled") {
        throw new InvalidTransitionError();
      }
      const window = { start: appointment.start, end: appointment.end };

      // No resolvable own schedule → no way to re-protect the window → refuse (409)
      // rather than restore a booking $find could double-book. Fail toward blocking.
      const scheduleRef = await ownScheduleRef(caller, appointment);
      if (!scheduleRef) {
        throw new StatusConflictError();
      }
      const free = await windowIsFree(caller, scheduleRef, window, []);
      if (!free) {
        // The freed window was taken inside the undo period — surfaced honestly,
        // same contract as the S5.5 undo's own 409.
        throw new StatusConflictError();
      }

      // Protector first, then a RE-CHECK with our claim visible (the S5.5 pattern —
      // no serializable operation at our pin, so the check-then-act gap closes to a
      // search round-trip), then the test-and-set patch; any failure compensates by
      // removing the new slot so a failed restore never leaves the window blocked.
      const writer = await deps.getFhirClient();
      const newSlot = await writer.createResource<Slot>({
        resourceType: "Slot",
        schedule: { reference: scheduleRef },
        status: "busy",
        start: window.start,
        end: window.end,
      });
      try {
        const stillFree = await windowIsFree(caller, scheduleRef, window, [`Slot/${newSlot.id}`]);
        if (!stillFree) {
          throw new StatusConflictError();
        }
        await caller.patchResource("Appointment", appointmentId, [
          { op: "test", path: "/status", value: "cancelled" },
          ...(appointment.meta?.versionId
            ? [{ op: "test" as const, path: "/meta/versionId", value: appointment.meta.versionId }]
            : []),
          { op: "replace", path: "/status", value: "booked" },
          ...(appointment.cancelationReason
            ? [{ op: "remove" as const, path: "/cancelationReason" }]
            : []),
          { op: "add", path: "/slot", value: [{ reference: `Slot/${newSlot.id}` }] },
        ]);
      } catch (err) {
        await writer.deleteResource("Slot", newSlot.id!).catch(() => {
          console.warn(`restore: compensation failed, stranded busy slot Slot/${newSlot.id}`);
        });
        rethrowPatchFailure(err);
      }

      return { id: appointmentId, status: "scheduled" };
    },
  };
}
