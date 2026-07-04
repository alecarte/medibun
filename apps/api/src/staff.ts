import type {
  AppointmentStatus,
  DaySheet,
  DaySheetAppointment,
  DaySheetPractitioner,
  ServiceColor,
  StaffProfile,
} from "@medibun/api-client";
import {
  hasAppointmentBefore,
  listDayAppointments,
  listSchedules,
  practitionerTimezone,
  readAppointmentById,
  readPractitionerById,
  SERVICES_CODE_SYSTEM,
  updateAppointmentStatus,
  type AppointmentPatcher,
  type DaySheetReader,
  type FhirOpsClient,
} from "@medibun/medplum-backend";
import type { Appointment, Patient, Practitioner } from "@medibun/fhir-types";

import { humanNameDisplay } from "./patients.js";
import type { ServiceCatalog, ServiceRow } from "./services/catalog.js";

/**
 * Staff surface (S5): the Today day sheet and the appointment-status workflow.
 *
 * Principal: everything here runs AS THE SIGNED-IN STAFF MEMBER (their Medplum token
 * from the session store) — unlike S4 booking's service client. Their org-parameterized
 * AccessPolicy is the enforcement line and every AuditEvent is attributed to them by
 * construction (docs/AUTH.md). The check-in Bot — not this module — writes the
 * Encounter (A7, boundary discipline).
 */

/** Domain workflow → FHIR Appointment.status. "roomed" rides FHIR's checked-in code:
 *  arrived = at the front desk, checked-in = in the treatment room (R4 vocabulary). */
const FHIR_BY_DOMAIN: Record<AppointmentStatus, NonNullable<Appointment["status"]>> = {
  scheduled: "booked",
  arrived: "arrived",
  roomed: "checked-in",
  completed: "fulfilled",
  "no-show": "noshow",
};

const DOMAIN_BY_FHIR = new Map<Appointment["status"], AppointmentStatus>(
  (Object.entries(FHIR_BY_DOMAIN) as [AppointmentStatus, Appointment["status"]][]).map(
    ([domain, fhir]) => [fhir, domain],
  ),
);

/** Allowed moves: each forward step plus its exact reverse (the ~10s undo,
 *  DESIGN.md undo-over-confirm). Everything else is a stale-client conflict. */
const TRANSITIONS: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  scheduled: ["arrived", "no-show"],
  arrived: ["roomed", "scheduled"],
  roomed: ["completed", "arrived"],
  completed: ["roomed"],
  "no-show": ["scheduled"],
};

/** The requested move isn't legal from the appointment's CURRENT status — almost always
 *  a stale day sheet (another station moved it first). Client refetches. */
export class InvalidTransitionError extends Error {
  constructor() {
    super("status transition not allowed from the current status");
    this.name = "InvalidTransitionError";
  }
}

/** No such appointment (or the caller's policy hides it). */
export class UnknownAppointmentError extends Error {
  constructor() {
    super("appointment not found");
    this.name = "UnknownAppointmentError";
  }
}

/** Offset between the zone's wall clock and UTC at an instant (DST-aware). */
function tzOffsetMs(instantMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(instantMs))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24, // some ICU builds render midnight as "24"
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - instantMs;
}

/**
 * The practice-local calendar day containing `now`: its date string and [start, end)
 * instants. DST-safe: the double correction converges on zones where a transition sits
 * between the UTC guess and local midnight, so fall-back days are truly 25h long.
 */
export function zonedDayBounds(
  now: Date,
  timeZone: string,
): { date: string; start: Date; end: Date } {
  // en-CA renders YYYY-MM-DD directly.
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const startOf = (ymd: string): Date => {
    const utcGuess = Date.parse(`${ymd}T00:00:00Z`);
    let t = utcGuess - tzOffsetMs(utcGuess, timeZone);
    t = utcGuess - tzOffsetMs(t, timeZone);
    return new Date(t);
  };
  const [y, m, d] = date.split("-").map(Number);
  const nextYmd = new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
  return { date, start: startOf(date), end: startOf(nextYmd) };
}

const telecomValue = (patient: Patient, system: "phone" | "email"): string | undefined =>
  patient.telecom?.find((t) => t.system === system && t.value)?.value;

const ourServiceCode = (appointment: Appointment): string | undefined =>
  appointment.serviceType
    ?.flatMap((concept) => concept.coding ?? [])
    .find((coding) => coding.system === SERVICES_CODE_SYSTEM)?.code;

const practitionerParticipant = (appointment: Appointment): string | undefined =>
  appointment.participant
    ?.map((p) => p.actor?.reference)
    .find((ref) => ref?.startsWith("Practitioner/"));

const patientParticipant = (appointment: Appointment): string | undefined =>
  appointment.participant
    ?.map((p) => p.actor?.reference)
    .find((ref) => ref?.startsWith("Patient/"));

/** The client surface staff calls need, bound to the STAFF USER's own token. */
export type StaffUserClient = FhirOpsClient & AppointmentPatcher & DaySheetReader;

export type SessionUser = { profileReference: string; accessToken: string };

export type StaffService = {
  /** The staff member's own profile, or undefined for non-Practitioner principals. */
  readonly getStaffProfile: (user: SessionUser) => Promise<StaffProfile | undefined>;
  /** Today's practitioner-column day sheet, practice-local. */
  readonly getDaySheet: (user: SessionUser) => Promise<DaySheet>;
  /** Moves an appointment through the workflow. Throws InvalidTransitionError /
   *  UnknownAppointmentError (plus the medplum-backend auth/conflict errors). */
  readonly setAppointmentStatus: (
    user: SessionUser,
    appointmentId: string,
    to: AppointmentStatus,
  ) => Promise<{ id: string; status: AppointmentStatus }>;
};

export function createStaffService(deps: {
  readonly catalog: Pick<ServiceCatalog, "listActive">;
  /** A Medplum client authenticated with the GIVEN access token (the end user's). */
  readonly userClient: (accessToken: string) => StaffUserClient;
  /** Injectable clock (tests). */
  readonly now?: () => Date;
}): StaffService {
  const now = deps.now ?? (() => new Date());

  const practitionerId = (user: SessionUser): string | undefined => {
    const [resourceType, id] = user.profileReference.split("/");
    return resourceType === "Practitioner" && id ? id : undefined;
  };

  return {
    async getStaffProfile(user) {
      const id = practitionerId(user);
      if (!id) {
        return undefined; // not a staff principal (e.g. a patient session)
      }
      const practitioner = await readPractitionerById(deps.userClient(user.accessToken), id);
      return practitioner && { id, name: humanNameDisplay(practitioner.name?.[0]) };
    },

    async getDaySheet(user) {
      const client = deps.userClient(user.accessToken);
      // Columns + practice timezone come from the Schedules (one actor each, S3 seed);
      // the catalog resolves service names/colors. Independent reads — run together.
      const [schedules, services] = await Promise.all([
        listSchedules(client),
        deps.catalog.listActive(),
      ]);
      const serviceByCode = new Map<string, ServiceRow>(services.map((s) => [s.code, s]));
      const timezone =
        schedules
          .map(({ practitioner }) => practitioner && practitionerTimezone(practitioner))
          .find(Boolean) ?? "UTC";
      const bounds = zonedDayBounds(now(), timezone);
      const day = await listDayAppointments(client, {
        start: bounds.start.toISOString(),
        end: bounds.end.toISOString(),
      });

      // Columns: schedule actors first, then any practitioner an appointment references
      // that has no schedule (never silently drop a booked appointment's column).
      const columns = new Map<string, Practitioner>();
      for (const { practitioner } of schedules) {
        if (practitioner?.id) {
          columns.set(practitioner.id, practitioner);
        }
      }
      for (const [reference, practitioner] of day.practitioners) {
        const id = reference.split("/")[1];
        if (id && !columns.has(id)) {
          columns.set(id, practitioner);
        }
      }

      // Appointments we can render: a mapped workflow status + patient + practitioner.
      // Unmapped statuses (cancelled, entered-in-error, proposed…) are not day-sheet rows.
      const mappable = day.appointments.flatMap((appointment) => {
        const status = DOMAIN_BY_FHIR.get(appointment.status);
        const patientRef = patientParticipant(appointment);
        const practitionerRef = practitionerParticipant(appointment);
        return status && patientRef && practitionerRef && appointment.start && appointment.end
          ? [{ appointment, status, patientRef, practitionerRef }]
          : [];
      });

      // First-visit lookups, once per unique patient (the new-patient marker).
      const uniquePatients = [...new Set(mappable.map((m) => m.patientRef))];
      const knownFace = new Map(
        await Promise.all(
          uniquePatients.map(
            async (ref): Promise<[string, boolean]> => [
              ref,
              await hasAppointmentBefore(client, ref, bounds.start.toISOString()),
            ],
          ),
        ),
      );

      const appointments: DaySheetAppointment[] = mappable.map(
        ({ appointment, status, patientRef, practitionerRef }) => {
          const patient = day.patients.get(patientRef);
          const serviceCode = ourServiceCode(appointment);
          const service = serviceCode ? serviceByCode.get(serviceCode) : undefined;
          return {
            id: appointment.id!,
            practitionerId: practitionerRef.split("/")[1]!,
            patientId: patientRef.split("/")[1]!,
            patientName: patient ? humanNameDisplay(patient.name?.[0]) : "Unknown",
            ...(patient && telecomValue(patient, "phone")
              ? { patientPhone: telecomValue(patient, "phone") }
              : {}),
            ...(patient && telecomValue(patient, "email")
              ? { patientEmail: telecomValue(patient, "email") }
              : {}),
            ...(serviceCode ? { serviceCode } : {}),
            ...(service ? { serviceName: service.name } : {}),
            ...(service ? { serviceColor: service.categoryColor as ServiceColor } : {}),
            start: appointment.start!,
            end: appointment.end!,
            status,
            firstVisit: !(knownFace.get(patientRef) ?? false),
            ...(appointment.created ? { bookedAt: appointment.created } : {}),
          };
        },
      );

      const practitioners: DaySheetPractitioner[] = [...columns.entries()]
        .map(([id, practitioner]) => ({
          practitionerId: id,
          practitionerName: humanNameDisplay(practitioner.name?.[0]),
        }))
        .sort((a, b) => a.practitionerName.localeCompare(b.practitionerName));

      return {
        date: bounds.date,
        timezone,
        practitioners,
        appointments: appointments.sort((a, b) => a.start.localeCompare(b.start)),
      };
    },

    async setAppointmentStatus(user, appointmentId, to) {
      const client = deps.userClient(user.accessToken);
      const appointment = await readAppointmentById(client, appointmentId);
      if (!appointment) {
        throw new UnknownAppointmentError();
      }
      const current = DOMAIN_BY_FHIR.get(appointment.status);
      if (!current || !TRANSITIONS[current].includes(to)) {
        throw new InvalidTransitionError();
      }
      // Atomic test-and-set on the CURRENT status: a concurrent move at another
      // station surfaces as StatusConflictError, never a silent clobber.
      await updateAppointmentStatus(client, {
        id: appointmentId,
        from: FHIR_BY_DOMAIN[current],
        to: FHIR_BY_DOMAIN[to],
      });
      return { id: appointmentId, status: to };
    },
  };
}
