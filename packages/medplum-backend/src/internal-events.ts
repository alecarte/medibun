import { isGone, isNotFound, OperationOutcomeError } from "@medplum/core";
import type { Appointment, Resource, Slot } from "@medplum/fhirtypes";

/**
 * Internal (non-patient) calendar events — day off, staff meeting, misc block (S5c,
 * DATA_MODEL.md amendment). An event is a patient-less Appointment carrying our
 * internal-events code PLUS one busy-unavailable Slot per overlapping Schedule, so
 * $find can never offer the blocked window (the same Appointment+Slot pairing $book
 * creates for real bookings). Writes run under the BFF service client (decided
 * 2026-07-06 — staff Slot access stays readonly); the acting staff user is known at
 * the BFF layer, same attribution tradeoff as S4 booking.
 */

export const INTERNAL_EVENTS_CODE_SYSTEM = "https://medibun.com/fhir/CodeSystem/internal-events";

/** The write surface these ops need (satisfied by MedplumClient; injectable in tests). */
export type ResourceWriter = {
  createResource<T extends Resource>(resource: T): Promise<T>;
  deleteResource(resourceType: "Appointment" | "Slot", id: string): Promise<unknown>;
};

/** Refused: the appointment is not an internal event (or is malformed enough that we
 *  won't touch it) — patient bookings are untouchable through the events path. */
export class NotAnInternalEventError extends Error {
  constructor() {
    super("appointment is not an internal event");
    this.name = "NotAnInternalEventError";
  }
}

/** The event's code from OUR CodeSystem, or undefined for anything else. */
export function internalEventCode(appointment: Appointment): string | undefined {
  return appointment.appointmentType?.coding?.find(
    (coding) => coding.system === INTERNAL_EVENTS_CODE_SYSTEM,
  )?.code;
}

/** An internal event carries our code AND no patient participant — both checked, so a
 *  malformed resource can never be treated (or deleted) as an event. */
export function isInternalEvent(appointment: Appointment): boolean {
  return (
    internalEventCode(appointment) !== undefined &&
    !(appointment.participant ?? []).some((p) => p.actor?.reference?.startsWith("Patient/"))
  );
}

/**
 * Create the event: busy-unavailable Slots first (one per affected Schedule), then the
 * patient-less Appointment referencing them (Appointment.slot is what makes deletion
 * find its blocks). If the Appointment write fails, the created Slots are compensated
 * away — orphan busy slots would block booking with no visible event.
 */
export async function createInternalEvent(
  client: ResourceWriter,
  opts: {
    /** Internal-events code ("day-off" | "meeting" | "block") — validated by the BFF. */
    readonly code: string;
    /** Display title. NON-PHI BY RULE (renders unmasked; see DATA_MODEL.md). */
    readonly title?: string;
    readonly practitionerReferences: readonly string[];
    /** Every Schedule the window must block ($find fans out per schedule). */
    readonly scheduleReferences: readonly string[];
    readonly start: string;
    readonly end: string;
  },
): Promise<Appointment> {
  const slots: Slot[] = [];
  try {
    for (const scheduleReference of opts.scheduleReferences) {
      slots.push(
        await client.createResource<Slot>({
          resourceType: "Slot",
          schedule: { reference: scheduleReference },
          status: "busy-unavailable",
          start: opts.start,
          end: opts.end,
        }),
      );
    }
    return await client.createResource<Appointment>({
      resourceType: "Appointment",
      status: "booked",
      appointmentType: { coding: [{ system: INTERNAL_EVENTS_CODE_SYSTEM, code: opts.code }] },
      ...(opts.title ? { description: opts.title } : {}),
      start: opts.start,
      end: opts.end,
      slot: slots.map((slot) => ({ reference: `Slot/${slot.id}` })),
      participant: opts.practitionerReferences.map((reference) => ({
        actor: { reference },
        status: "accepted" as const,
      })),
    });
  } catch (err) {
    const results = await Promise.allSettled(
      slots.map((slot) => client.deleteResource("Slot", slot.id!)),
    );
    // A failed rollback strands busy slots that block booking with no visible event —
    // say so (resource ids only, never PHI) instead of failing silently.
    const stranded = slots
      .filter((_, i) => results[i]!.status === "rejected")
      .map((slot) => `Slot/${slot.id}`);
    if (stranded.length > 0) {
      console.warn(
        `internal-events: slot rollback failed, stranded busy slots: ${stranded.join(", ")}`,
      );
    }
    throw err;
  }
}

/**
 * Delete the event: Slots first, then the Appointment — if the Appointment delete
 * fails, the event stays visible and the delete is retryable (already-gone slots are
 * tolerated), so repeated attempts converge instead of stranding invisible blocks.
 */
export async function deleteInternalEvent(
  client: ResourceWriter,
  appointment: Appointment,
): Promise<void> {
  if (!isInternalEvent(appointment)) {
    throw new NotAnInternalEventError();
  }
  for (const ref of appointment.slot ?? []) {
    const id = ref.reference?.split("/")[1];
    if (!id) {
      continue;
    }
    try {
      await client.deleteResource("Slot", id);
    } catch (err) {
      if (
        err instanceof OperationOutcomeError &&
        (isNotFound(err.outcome) || isGone(err.outcome))
      ) {
        continue;
      }
      throw err;
    }
  }
  await client.deleteResource("Appointment", appointment.id!);
}
