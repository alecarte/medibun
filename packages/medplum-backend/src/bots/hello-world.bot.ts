import type { BotEvent, MedplumClient } from "@medplum/core";
import type { AuditEvent, Patient } from "@medplum/fhirtypes";

/**
 * Hello-world Medplum Bot. Fired by a Subscription on Patient create (see
 * scripts/verify-subscription.ts). It writes a PHI-free AuditEvent referencing the patient by ID
 * only — proving the Subscription → Bot loop end to end without logging any PHI.
 *
 * NOTE (CLAUDE.md): no patient name/DOB/identifiers in the audit — reference by resource id only.
 */
export async function handler(
  medplum: MedplumClient,
  event: BotEvent<Patient>,
): Promise<AuditEvent> {
  const patient = event.input;
  return medplum.createResource<AuditEvent>({
    resourceType: "AuditEvent",
    recorded: new Date().toISOString(),
    type: {
      system: "http://terminology.hl7.org/CodeSystem/audit-event-type",
      code: "rest",
      display: "RESTful Operation",
    },
    action: "C",
    outcome: "0",
    agent: [
      {
        who: { display: "hello-world-bot" },
        requestor: false,
      },
    ],
    source: { observer: { display: "hello-world-bot" } },
    entity: [
      {
        what: { reference: `Patient/${patient.id}` },
        // No PHI — a benign marker so the verify script can find this AuditEvent.
        detail: [{ type: "hello-world-bot", valueString: "fired" }],
      },
    ],
  });
}
