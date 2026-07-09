import type {
  BookedAppointment,
  BookingRequest,
  PractitionerAvailability,
  ServiceAvailability,
  ServiceSummary,
} from "@medibun/api-client";
import {
  bookAppointment,
  findSlots,
  listSchedulesForService,
  practiceTimezone,
  type FhirOpsClient,
  type ScheduleWithActor,
} from "@medibun/medplum-backend";
import type { Practitioner } from "@medibun/fhir-types";

import { humanNameDisplay } from "./patients.js";
import type { ServiceCatalog, ServiceRow } from "./services/catalog.js";

/**
 * Booking (S4): domain ⇄ FHIR translation for discover → availability → book.
 *
 * Principals (DATA_MODEL.md access table: patients "read own, book via BFF"): scheduling
 * reads and $book run under the BFF's service client — the patient AccessPolicy grants no
 * Schedule/Slot/Appointment rights, and widening it is approval-gated. The acting patient
 * comes from the session and is written onto the Appointment (patient-reference), so the
 * clinical record stays attributable. NOTE for A3 (BFF ClientApplication scoping): the
 * service client's policy must keep Schedule/Slot/Appointment/HealthcareService/
 * Practitioner read + $find/$book for this module.
 */

/** The BFF-owned availability window: now through the coming week. */
const BOOKING_WINDOW_DAYS = 7;

/** The requested service code isn't on the active menu (or has no FHIR counterpart). */
export class UnknownServiceError extends Error {
  constructor() {
    super("unknown or inactive service");
    this.name = "UnknownServiceError";
  }
}

/** The requested schedule doesn't offer the requested service. */
export class UnknownScheduleError extends Error {
  constructor() {
    super("schedule does not offer the requested service");
    this.name = "UnknownScheduleError";
  }
}

/** The requested slot start is unparseable or in the past. */
export class InvalidSlotError extends Error {
  constructor() {
    super("slot start is not a bookable instant");
    this.name = "InvalidSlotError";
  }
}

const toServiceSummary = (row: ServiceRow): ServiceSummary => ({
  code: row.code,
  name: row.name,
  description: row.description,
  durationMinutes: row.durationMinutes,
  priceCents: row.priceCents,
  categoryColor: row.categoryColor,
});

const practitionerName = (practitioner: Practitioner): string =>
  humanNameDisplay(practitioner.name?.[0]);

/** Schedules we can actually offer: an id plus a resolvable Practitioner actor. */
const offerable = (
  entries: ScheduleWithActor[],
): { scheduleId: string; practitioner: Practitioner & { id: string } }[] =>
  entries.flatMap((entry) => {
    const scheduleId = entry.schedule.id;
    const practitioner = entry.practitioner;
    return scheduleId && practitioner?.id
      ? [{ scheduleId, practitioner: practitioner as Practitioner & { id: string } }]
      : [];
  });

export type BookingService = {
  /** The active service menu (experience DB — catalog data, no PHI). */
  readonly listServices: () => Promise<ServiceSummary[]>;
  /** $find fanned out across the service's practitioner schedules. Throws UnknownServiceError. */
  readonly getAvailability: (serviceCode: string) => Promise<ServiceAvailability>;
  /** $book as the service client, attributed to the session patient. Throws
   *  SlotTakenError / UnknownServiceError / UnknownScheduleError / InvalidSlotError. */
  readonly book: (patientReference: string, request: BookingRequest) => Promise<BookedAppointment>;
};

export function createBookingService(deps: {
  readonly catalog: Pick<ServiceCatalog, "listActive" | "getByCode">;
  /** Service-client principal per the module note above. */
  readonly getFhirClient: () => Promise<FhirOpsClient>;
  /** Injectable clock (tests). */
  readonly now?: () => Date;
}): BookingService {
  const now = deps.now ?? (() => new Date());

  const activeService = async (serviceCode: string): Promise<ServiceRow> => {
    const service = await deps.catalog.getByCode(serviceCode);
    if (!service?.active || !service.healthcareServiceId) {
      throw new UnknownServiceError();
    }
    return service;
  };

  // Catalog (Postgres) and schedule lookup (FHIR) are independent — run them
  // together. allSettled so an unknown service deterministically wins the error
  // (404 semantics) over a concurrent FHIR failure.
  const serviceAndSchedules = async (serviceCode: string) => {
    const [serviceResult, schedulesResult] = await Promise.allSettled([
      activeService(serviceCode),
      deps
        .getFhirClient()
        .then((client) =>
          listSchedulesForService(client, serviceCode).then(
            (schedules) => [client, offerable(schedules)] as const,
          ),
        ),
    ]);
    if (serviceResult.status === "rejected") {
      throw serviceResult.reason;
    }
    if (schedulesResult.status === "rejected") {
      throw schedulesResult.reason;
    }
    const [client, schedules] = schedulesResult.value;
    return { service: serviceResult.value, client, schedules };
  };

  return {
    async listServices() {
      const rows = await deps.catalog.listActive();
      // Only services that can complete the flow: a row without its FHIR
      // HealthcareService would 404 at the availability step (activeService).
      return rows.filter((row) => row.healthcareServiceId).map(toServiceSummary);
    },

    async getAvailability(serviceCode) {
      const { service, client, schedules } = await serviceAndSchedules(serviceCode);
      const windowStart = now();
      const windowEnd = new Date(windowStart.getTime() + BOOKING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const practitioners = await Promise.all(
        schedules.map(async ({ scheduleId, practitioner }): Promise<PractitionerAvailability> => {
          const slots = await findSlots(client, {
            scheduleId,
            healthcareServiceReference: `HealthcareService/${service.healthcareServiceId}`,
            start: windowStart.toISOString(),
            end: windowEnd.toISOString(),
          });
          return {
            scheduleId,
            practitionerId: practitioner.id,
            practitionerName: practitionerName(practitioner),
            slots: slots
              .map((slot) => ({ start: slot.start, end: slot.end }))
              .sort((a, b) => a.start.localeCompare(b.start)),
          };
        }),
      );
      return {
        serviceCode,
        // One practice timezone for the whole payload (v0: single location; all actors
        // carry the same zone). Review fix: per-practitioner timezones let one missing
        // extension silently re-bucket the patient's calendar mid-flow.
        timezone: practiceTimezone(schedules) ?? "UTC",
        // The client renders exactly THIS window — it never mints its own clock.
        windowStart: windowStart.toISOString(),
        windowDays: BOOKING_WINDOW_DAYS,
        practitioners: practitioners.sort((a, b) =>
          a.practitionerName.localeCompare(b.practitionerName),
        ),
      };
    },

    async book(patientReference, request) {
      const startMs = Date.parse(request.start);
      // One minute of grace so "book the slot starting now" never loses to clock skew.
      // Whether $book rejects an off-hours/off-grid start is Medplum's contract at
      // v5.1.9 — on the live-verify checklist (V0_PROPOSAL §9); we don't re-derive
      // availability here on an unverified assumption about $find grid alignment.
      if (Number.isNaN(startMs) || startMs < now().getTime() - 60_000) {
        throw new InvalidSlotError();
      }
      const { service, client, schedules } = await serviceAndSchedules(request.serviceCode);
      // The scheduleId is client-supplied — re-derive it from the service so a crafted
      // request can't book a mislabeled service onto another schedule.
      const match = schedules.find((s) => s.scheduleId === request.scheduleId);
      if (!match) {
        throw new UnknownScheduleError();
      }
      const start = new Date(startMs).toISOString();
      const end = new Date(startMs + service.durationMinutes * 60_000).toISOString();
      const booked = await bookAppointment(client, {
        slot: { start, end, scheduleReference: `Schedule/${request.scheduleId}` },
        serviceCode: request.serviceCode,
        patientReference,
      });
      return {
        id: booked.appointmentId,
        serviceCode: request.serviceCode,
        serviceName: service.name,
        practitionerName: practitionerName(match.practitioner),
        start: booked.start,
        end: booked.end,
      };
    },
  };
}
