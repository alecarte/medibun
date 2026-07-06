import type { Appointment, Bundle, Slot } from "@medplum/fhirtypes";

import { bundleResources } from "./scheduling.js";
import type { FhirOpsClient } from "./scheduling.js";

/**
 * Reschedule primitives (S5.5, drag-to-reschedule). No $reschedule operation exists at
 * our Medplum pin — a move is an Appointment patch plus a busy-Slot swap; these helpers
 * locate the booking's blocking slot(s) and check that a target window is actually free.
 * Every read runs on the CALLER-CHOSEN client (the BFF decides the principal).
 */

/** Slot statuses that block a window. `free` (never minted by us) and `entered-in-error`
 *  don't; everything busy-ish does. */
const BLOCKING = new Set<Slot["status"]>(["busy", "busy-unavailable", "busy-tentative"]);

/**
 * The busy Slot reference(s) protecting a booking's window. Prefers the appointment's
 * own `slot[]` references; falls back to searching the exact window across schedules
 * (whether `$book` populates `Appointment.slot` is a live-verify item — the fallback
 * makes the reschedule correct either way).
 */
export async function resolveBookedSlots(
  client: FhirOpsClient,
  appointment: Appointment,
): Promise<string[]> {
  const refs = (appointment.slot ?? [])
    .map((s) => s.reference)
    .filter((r): r is string => Boolean(r));
  if (refs.length > 0) {
    return refs;
  }
  const params = new URLSearchParams({
    start: appointment.start!,
    _count: "100",
  });
  const bundle = (await client.get(`fhir/R4/Slot?${params.toString()}`)) as Bundle;
  return bundleResources(bundle)
    .filter(
      (r): r is Slot =>
        r.resourceType === "Slot" &&
        Boolean(r.id) &&
        BLOCKING.has((r as Slot).status) &&
        (r as Slot).end === appointment.end,
    )
    .map((slot) => `Slot/${slot.id}`);
}

/**
 * Whether [start, end) on `scheduleReference` overlaps no blocking Slot, ignoring
 * `ownSlotRefs` (moving within your own window is legal). Deliberately does NOT check
 * schedule availability hours: patients can't book off-hours ($find enforces that),
 * but the front desk placing a deliberate off-hours squeeze-in is staff judgment
 * (decided at the S5.5 interview). Conflicts are what matter.
 */
export async function windowIsFree(
  client: FhirOpsClient,
  scheduleReference: string,
  window: { readonly start: string; readonly end: string },
  ownSlotRefs: readonly string[],
): Promise<boolean> {
  const params = new URLSearchParams({
    schedule: scheduleReference,
    // Overlap = starts before the window ends AND ends after the window starts.
    start: `lt${window.end}`,
    _count: "100",
  });
  const bundle = (await client.get(`fhir/R4/Slot?${params.toString()}`)) as Bundle;
  const own = new Set(ownSlotRefs);
  return !bundleResources(bundle).some(
    (r) =>
      r.resourceType === "Slot" &&
      BLOCKING.has((r as Slot).status) &&
      (r as Slot).end! > window.start &&
      !own.has(`Slot/${r.id}`),
  );
}
