import {
  INTERNAL_EVENT_TYPES,
  STATUS_TRANSITIONS,
  weekStart,
  type AppointmentStatus,
  type DaySheet,
  type DaySheetAppointment,
  type DaySheetPractitioner,
  type InternalEvent,
  type ServiceColor,
  type StaffProfile,
} from "@medibun/api-client";
import {
  hasAppointmentBefore,
  internalEventCode,
  isInternalEvent,
  listDayAppointments,
  listSchedules,
  practiceTimezone,
  readAppointmentById,
  readPractitionerById,
  serviceCodeOf,
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

/** Per-timezone cached Intl formatters — construction is expensive and the day-bounds
 *  math calls these several times per request. */
const wallClockFormatters = new Map<string, Intl.DateTimeFormat>();
function wallClockFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = wallClockFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    wallClockFormatters.set(timeZone, formatter);
  }
  return formatter;
}

const ymdFormatters = new Map<string, Intl.DateTimeFormat>();
function ymdFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = ymdFormatters.get(timeZone);
  if (!formatter) {
    // en-CA renders YYYY-MM-DD directly.
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    ymdFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Offset between the zone's wall clock and UTC at an instant (DST-aware). */
function tzOffsetMs(instantMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    wallClockFormatter(timeZone)
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
 * The instant at a practice-local wall time ("HH:mm") on a calendar date. DST-safe:
 * the double correction converges on zones where a transition sits between the UTC
 * guess and the local wall time. The BFF is the only place wall time becomes UTC —
 * clients send practice-local values and never do timezone math.
 */
export function zonedInstant(date: string, time: string, timeZone: string): Date {
  const utcGuess = Date.parse(`${date}T${time}:00Z`);
  let t = utcGuess - tzOffsetMs(utcGuess, timeZone);
  t = utcGuess - tzOffsetMs(t, timeZone);
  return new Date(t);
}

/**
 * [start, end) instants of one practice-local calendar date. DST-safe via
 * zonedInstant, so fall-back days are truly 25h long.
 */
export function dayBoundsFor(
  date: string,
  timeZone: string,
): { date: string; start: Date; end: Date } {
  const [y, m, d] = date.split("-").map(Number);
  const nextYmd = new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
  return {
    date,
    start: zonedInstant(date, "00:00", timeZone),
    end: zonedInstant(nextYmd, "00:00", timeZone),
  };
}

/** The practice-local calendar day containing `now`. */
export function zonedDayBounds(
  now: Date,
  timeZone: string,
): { date: string; start: Date; end: Date } {
  return dayBoundsFor(ymdFormatter(timeZone).format(now), timeZone);
}

export const telecomValue = (patient: Patient, system: "phone" | "email"): string | undefined =>
  patient.telecom?.find((t) => t.system === system && t.value)?.value;

/** The first Practitioner participant's reference — the day sheet's and the
 *  reschedule route's shared "which participant is the practitioner" convention. */
export const practitionerParticipant = (appointment: Appointment): string | undefined =>
  appointment.participant
    ?.map((p) => p.actor?.reference)
    .find((ref) => ref?.startsWith("Practitioner/"));

export const patientParticipant = (appointment: Appointment): string | undefined =>
  appointment.participant
    ?.map((p) => p.actor?.reference)
    .find((ref) => ref?.startsWith("Patient/"));

/** The client surface staff calls need, bound to the STAFF USER's own token. */
export type StaffUserClient = FhirOpsClient & AppointmentPatcher & DaySheetReader;

export type SessionUser = { profileReference: string; accessToken: string };

export type StaffService = {
  /** The staff member's own profile, or undefined for non-Practitioner principals. */
  readonly getStaffProfile: (user: SessionUser) => Promise<StaffProfile | undefined>;
  /** The schedule sheet for `days` consecutive practice-local days starting at `date`
   *  (default: today, 1 day; week view fetches 7). `date`/`days` are pre-validated
   *  (isValidDateString, days ∈ {1,7}) by the route. */
  readonly getDaySheet: (user: SessionUser, date?: string, days?: number) => Promise<DaySheet>;
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

    async getDaySheet(user, date, days = 1) {
      const client = deps.userClient(user.accessToken);
      // Columns + practice timezone come from the Schedules (one actor each, S3 seed);
      // the catalog resolves service names/colors. Independent reads — run together.
      const [schedules, services] = await Promise.all([
        listSchedules(client),
        deps.catalog.listActive(),
      ]);
      const serviceByCode = new Map<string, ServiceRow>(services.map((s) => [s.code, s]));
      // Display path: a missing practice timezone shifts labels, never a write — the
      // UTC fallback is tolerable here (the reschedule write path hard-fails instead).
      const timezone = practiceTimezone(schedules) ?? "UTC";
      // Range start: the requested date (or today). Week view (days=7) snaps to the
      // week's Monday HERE — the BFF is the practice-timezone authority, so the client
      // never has to know "today" to land on a Monday.
      const rawStart = date ?? zonedDayBounds(now(), timezone).date;
      const startYmd = days === 7 ? weekStart(rawStart) : rawStart;
      const bounds = dayBoundsFor(startYmd, timezone);
      // Range end: the LAST day's own bounds, so DST days inside a week keep their true
      // lengths (a naive start + days*24h drifts across a transition).
      const lastYmd = (() => {
        const [y, m, d] = bounds.date.split("-").map(Number);
        return new Date(Date.UTC(y!, m! - 1, d! + (days - 1))).toISOString().slice(0, 10);
      })();
      const end = days === 1 ? bounds.end : dayBoundsFor(lastYmd, timezone).end;
      const day = await listDayAppointments(client, {
        start: bounds.start.toISOString(),
        end: end.toISOString(),
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

      // Internal events (S5c): patient-less appointments carrying our internal-events
      // code — day off / meeting / block. They render as their own muted blocks, never
      // as bookings (no status workflow, no PHI).
      const events: InternalEvent[] = day.appointments.flatMap((appointment) => {
        const type = INTERNAL_EVENT_TYPES.find((t) => t === internalEventCode(appointment));
        if (!type || !isInternalEvent(appointment) || !appointment.start || !appointment.end) {
          return [];
        }
        const practitionerIds = (appointment.participant ?? [])
          .map((p) => p.actor?.reference)
          .filter((ref): ref is string => Boolean(ref?.startsWith("Practitioner/")))
          .map((ref) => ref.split("/")[1]!);
        return [
          {
            id: appointment.id!,
            type,
            ...(appointment.description ? { title: appointment.description } : {}),
            practitionerIds,
            start: appointment.start,
            end: appointment.end,
          },
        ];
      });

      // Appointments we can render: a mapped workflow status + patient + practitioner.
      // Unmapped statuses (cancelled, entered-in-error, proposed…) are not day-sheet
      // rows — and neither are internal events (no patient participant).
      const mappable = day.appointments.flatMap((appointment) => {
        const status = DOMAIN_BY_FHIR.get(appointment.status);
        const patientRef = patientParticipant(appointment);
        const practitionerRef = practitionerParticipant(appointment);
        return status && patientRef && practitionerRef && appointment.start && appointment.end
          ? [{ appointment, status, patientRef, practitionerRef }]
          : [];
      });

      // First-visit lookups, once per unique patient (the new-patient marker) — in
      // bounded batches, not one burst: a week sheet can carry dozens of patients and
      // each lookup is its own FHIR search (the N+1 stays, its concurrency is capped).
      const uniquePatients = [...new Set(mappable.map((m) => m.patientRef))];
      const knownFace = new Map<string, boolean>();
      const FIRST_VISIT_BATCH = 10;
      for (let i = 0; i < uniquePatients.length; i += FIRST_VISIT_BATCH) {
        const batch = await Promise.all(
          uniquePatients
            .slice(i, i + FIRST_VISIT_BATCH)
            .map(
              async (ref): Promise<[string, boolean]> => [
                ref,
                await hasAppointmentBefore(client, ref, bounds.start.toISOString()),
              ],
            ),
        );
        for (const [ref, known] of batch) {
          knownFace.set(ref, known);
        }
      }

      // The patient's EARLIEST appointment in the fetched range: only that one can be
      // the first visit — a second booking inside the same week must not read as "New"
      // merely because both fall after the range start.
      const earliestInRange = new Map<string, { start: string; id: string }>();
      for (const m of mappable) {
        const current = earliestInRange.get(m.patientRef);
        if (!current || m.appointment.start! < current.start) {
          earliestInRange.set(m.patientRef, { start: m.appointment.start!, id: m.appointment.id! });
        }
      }

      const appointments: DaySheetAppointment[] = mappable.map(
        ({ appointment, status, patientRef, practitionerRef }) => {
          const patient = day.patients.get(patientRef);
          const serviceCode = serviceCodeOf(appointment);
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
            firstVisit:
              !(knownFace.get(patientRef) ?? false) &&
              earliestInRange.get(patientRef)?.id === appointment.id,
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
        days,
        timezone,
        practitioners,
        appointments: appointments.sort((a, b) => a.start.localeCompare(b.start)),
        events: events.sort((a, b) => a.start.localeCompare(b.start)),
      };
    },

    async setAppointmentStatus(user, appointmentId, to) {
      const client = deps.userClient(user.accessToken);
      const appointment = await readAppointmentById(client, appointmentId);
      // Internal events have no patient workflow — through the status path they are
      // indistinguishable from nothing (they also happen to sit at FHIR "booked").
      if (!appointment || isInternalEvent(appointment)) {
        throw new UnknownAppointmentError();
      }
      const current = DOMAIN_BY_FHIR.get(appointment.status);
      if (!current || !STATUS_TRANSITIONS[current].includes(to)) {
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
