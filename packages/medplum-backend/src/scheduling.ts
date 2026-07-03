import { isConflict, OperationOutcomeError } from "@medplum/core";
import type { Bundle, HealthcareService, Practitioner, Schedule, Slot } from "@medplum/fhirtypes";

/**
 * Medplum scheduling ($find/$book) — wire contracts verified against the v5.1.9 server
 * source (operations/find.ts, book.ts, utils/scheduling-parameters.ts, utils/scheduling.ts):
 * - GET Schedule/:id/$find with REQUIRED start, end, service-type-reference (≤31-day range);
 *   response is a searchset Bundle of free Slots.
 * - POST Appointment/$book with a Parameters body: 1+ proposed free Slot resources (+ optional
 *   patient-reference); 201 → searchset Bundle with the booked Appointment + busy Slot(s);
 *   409 when the window was taken (serializable transaction server-side).
 * - SchedulingParameters extension lives on Schedule (requires `service` + `availability`
 *   sub-extensions) and/or HealthcareService (which uses native availableTime instead).
 * - The IANA timezone extension lives on the Schedule's single actor resource.
 */

export const SCHEDULING_PARAMETERS_URL =
  "https://medplum.com/fhir/StructureDefinition/SchedulingParameters";
export const TIMEZONE_EXTENSION_URL = "http://hl7.org/fhir/StructureDefinition/timezone";
export const SERVICES_CODE_SYSTEM = "https://medibun.com/fhir/CodeSystem/services";

type MinutesDuration = {
  value: number;
  unit: "min";
  system: "http://unitsofmeasure.org";
  code: "min";
};
const minutes = (value: number): MinutesDuration => ({
  value,
  unit: "min",
  system: "http://unitsofmeasure.org",
  code: "min",
});

export type WeeklyAvailability = {
  readonly daysOfWeek: ("mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun")[];
  /** "09:00:00" local to the actor's timezone. */
  readonly startTime: string;
  readonly endTime: string;
};

/** A practitioner carrying the actor-level IANA timezone $find/$book require. */
export function buildPractitioner(opts: {
  readonly given: string;
  readonly family: string;
  readonly timezone: string;
}): Practitioner {
  return {
    resourceType: "Practitioner",
    name: [{ given: [opts.given], family: opts.family }],
    extension: [{ url: TIMEZONE_EXTENSION_URL, valueCode: opts.timezone }],
  };
}

/** A bookable service: our CodeSystem code + duration via SchedulingParameters. */
export function buildHealthcareService(opts: {
  readonly code: string;
  readonly name: string;
  readonly durationMinutes: number;
  readonly bufferAfterMinutes?: number;
}): HealthcareService {
  return {
    resourceType: "HealthcareService",
    name: opts.name,
    type: [{ coding: [{ system: SERVICES_CODE_SYSTEM, code: opts.code }] }],
    extension: [
      {
        url: SCHEDULING_PARAMETERS_URL,
        extension: [
          { url: "duration", valueDuration: minutes(opts.durationMinutes) },
          ...(opts.bufferAfterMinutes
            ? [{ url: "bufferAfter", valueDuration: minutes(opts.bufferAfterMinutes) }]
            : []),
        ],
      },
    ],
  };
}

/**
 * A one-actor Schedule whose SchedulingParameters bind a HealthcareService and weekly
 * availability (both REQUIRED on Schedule-level parameters at v5.1.9).
 */
export function buildSchedule(opts: {
  readonly practitionerReference: string;
  readonly healthcareServiceReference: string;
  readonly durationMinutes: number;
  readonly availability: WeeklyAvailability;
}): Schedule {
  return {
    resourceType: "Schedule",
    actor: [{ reference: opts.practitionerReference }],
    extension: [
      {
        url: SCHEDULING_PARAMETERS_URL,
        extension: [
          { url: "service", valueReference: { reference: opts.healthcareServiceReference } },
          { url: "duration", valueDuration: minutes(opts.durationMinutes) },
          {
            url: "availability",
            extension: [
              {
                url: "availableTime",
                extension: [
                  ...opts.availability.daysOfWeek.map((d) => ({
                    url: "daysOfWeek",
                    valueCode: d,
                  })),
                  { url: "availableStartTime", valueTime: opts.availability.startTime },
                  { url: "availableEndTime", valueTime: opts.availability.endTime },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Minimal client surface (satisfied by MedplumClient) so the caller picks the principal. */
export type FhirOpsClient = {
  get(url: string): Promise<unknown>;
  post(url: string, body?: unknown, contentType?: string): Promise<unknown>;
};

export type SlotWindow = {
  readonly start: string;
  readonly end: string;
  readonly scheduleReference: string;
};

/** The proposed window was taken between $find and $book (server returns 409). */
export class SlotTakenError extends Error {
  constructor() {
    super("requested slot is no longer available");
    this.name = "SlotTakenError";
  }
}

/** Free slots for one schedule + service in [start, end] (≤31 days, server-enforced). */
export async function findSlots(
  client: FhirOpsClient,
  opts: {
    readonly scheduleId: string;
    readonly healthcareServiceReference: string;
    readonly start: string;
    readonly end: string;
    readonly count?: number;
  },
): Promise<Slot[]> {
  const params = new URLSearchParams({
    start: opts.start,
    end: opts.end,
    "service-type-reference": opts.healthcareServiceReference,
    ...(opts.count !== undefined ? { _count: String(opts.count) } : {}),
  });
  const bundle = (await client.get(
    `fhir/R4/Schedule/${encodeURIComponent(opts.scheduleId)}/$find?${params.toString()}`,
  )) as Bundle<Slot>;
  return (bundle.entry ?? []).flatMap((e) => (e.resource ? [e.resource] : []));
}

/** Book a found window. Resolves the created Appointment; throws SlotTakenError on 409. */
export async function bookAppointment(
  client: FhirOpsClient,
  opts: {
    readonly slot: SlotWindow;
    readonly serviceCode: string;
    readonly patientReference?: string;
  },
): Promise<{ appointmentId: string; start: string; end: string }> {
  const proposedSlot: Slot = {
    resourceType: "Slot",
    schedule: { reference: opts.slot.scheduleReference },
    start: opts.slot.start,
    end: opts.slot.end,
    status: "free",
    serviceType: [{ coding: [{ system: SERVICES_CODE_SYSTEM, code: opts.serviceCode }] }],
  };
  let bundle: Bundle;
  try {
    bundle = (await client.post("fhir/R4/Appointment/$book", {
      resourceType: "Parameters",
      parameter: [
        { name: "slot", resource: proposedSlot },
        ...(opts.patientReference
          ? [{ name: "patient-reference", valueReference: { reference: opts.patientReference } }]
          : []),
      ],
    })) as Bundle;
  } catch (err) {
    // Structural conflict detection (same pattern as patients.ts) — never string-match
    // diagnostics: the server 409s a taken window with a conflict OperationOutcome.
    if (err instanceof OperationOutcomeError && isConflict(err.outcome)) {
      throw new SlotTakenError();
    }
    throw err;
  }
  const appointment = (bundle.entry ?? [])
    .map((e) => e.resource)
    .find((r) => r?.resourceType === "Appointment");
  if (!appointment?.id || appointment.resourceType !== "Appointment") {
    throw new Error("$book returned no Appointment");
  }
  return {
    appointmentId: appointment.id,
    start: appointment.start ?? opts.slot.start,
    end: appointment.end ?? opts.slot.end,
  };
}
