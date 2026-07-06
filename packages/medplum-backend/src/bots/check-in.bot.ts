import { isGone, isNotFound, OperationOutcomeError } from "@medplum/core";
import type { BotEvent, MedplumClient } from "@medplum/core";
import type { Appointment, Encounter } from "@medplum/fhirtypes";

/**
 * Check-in Bot (S5, approval A7) — DETERMINISTIC event logic, no AI. Fired by a
 * Subscription on `Appointment?status=arrived,booked`.
 *
 * Encounter creation belongs HERE, not the BFF: front desk has no Encounter write in the
 * accepted policy table (DATA_MODEL.md), and clinical event logic runs on
 * Bots/Subscriptions (boundary discipline, .claude/rules/fhir.md).
 *
 * - status `arrived`  → ensure exactly one live Encounter exists for the appointment.
 * - status `booked`   → an undone check-in: void live Encounters (entered-in-error).
 *   New bookings also arrive as `booked` — with no live Encounter that's a no-op.
 *
 * Idempotent both ways (Subscriptions can redeliver). NOTE (CLAUDE.md): nothing here
 * logs or writes PHI values — resources are referenced by id only.
 */

/** Encounter statuses that still count as a real visit record (not voided/closed). */
const LIVE_ENCOUNTER_STATUSES: Encounter["status"][] = ["arrived", "triaged", "in-progress"];

export async function handler(medplum: MedplumClient, event: BotEvent<Appointment>): Promise<void> {
  const delivered = event.input;
  if (delivered.resourceType !== "Appointment" || !delivered.id) {
    return;
  }
  // Subscriptions deliver a SNAPSHOT and can arrive late, twice, or out of order (a
  // check-in undone inside the window fires `arrived` then `booked` — reversed delivery
  // would orphan an Encounter). Act only on the appointment's CURRENT server status.
  let appointment: Appointment;
  try {
    appointment = await medplum.readResource("Appointment", delivered.id);
  } catch (err) {
    // Only not-found/gone means "deleted since the event fired — nothing to reconcile".
    // Anything else (transient failure, a policy denial) must THROW so the Subscription
    // retries instead of silently skipping Encounter reconciliation.
    if (err instanceof OperationOutcomeError && (isNotFound(err.outcome) || isGone(err.outcome))) {
      return;
    }
    throw err;
  }
  const appointmentReference = `Appointment/${appointment.id}`;
  const encounters = await medplum.searchResources("Encounter", {
    appointment: appointmentReference,
    _count: "100",
  });
  const live = encounters.filter((e) => LIVE_ENCOUNTER_STATUSES.includes(e.status));

  if (appointment.status === "arrived") {
    if (live.length > 0) {
      return; // already checked in — redelivery or a second station
    }
    const patientReference = appointment.participant
      ?.map((p) => p.actor?.reference)
      .find((ref) => ref?.startsWith("Patient/"));
    await medplum.createResource<Encounter>({
      resourceType: "Encounter",
      status: "arrived",
      class: {
        system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
        code: "AMB",
        display: "ambulatory",
      },
      ...(patientReference ? { subject: { reference: patientReference } } : {}),
      ...(appointment.serviceType?.[0] ? { serviceType: appointment.serviceType[0] } : {}),
      appointment: [{ reference: appointmentReference }],
      period: { start: new Date().toISOString() },
    });
    return;
  }

  if (appointment.status === "booked") {
    // Undo path: the front desk reverted a check-in inside the undo window. The record
    // stays truthful — the Encounter is voided, never deleted (audit trail intact).
    for (const encounter of live) {
      await medplum.updateResource<Encounter>({ ...encounter, status: "entered-in-error" });
    }
  }
}
