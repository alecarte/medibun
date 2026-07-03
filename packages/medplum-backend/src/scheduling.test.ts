import { OperationOutcomeError } from "@medplum/core";
import { describe, expect, it, vi } from "vitest";

import {
  bookAppointment,
  buildHealthcareService,
  buildPractitioner,
  buildSchedule,
  findSlots,
  SCHEDULING_PARAMETERS_URL,
  SERVICES_CODE_SYSTEM,
  SlotTakenError,
  TIMEZONE_EXTENSION_URL,
} from "./scheduling.js";

describe("resource builders (shapes per the v5.1.9 wire contract)", () => {
  it("practitioner carries the actor-level IANA timezone extension", () => {
    const p = buildPractitioner({ given: "Riley", family: "Reyes", timezone: "America/New_York" });
    expect(p.extension).toEqual([{ url: TIMEZONE_EXTENSION_URL, valueCode: "America/New_York" }]);
  });

  it("healthcare service carries our CodeSystem code and a duration in minutes", () => {
    const hs = buildHealthcareService({ code: "svc-botox", name: "Botox", durationMinutes: 30 });
    expect(hs.type?.[0]?.coding?.[0]).toEqual({ system: SERVICES_CODE_SYSTEM, code: "svc-botox" });
    const params = hs.extension?.find((e) => e.url === SCHEDULING_PARAMETERS_URL);
    const duration = params?.extension?.find((e) => e.url === "duration");
    expect(duration?.valueDuration).toMatchObject({ value: 30, code: "min" });
    // service + availability are FORBIDDEN on HealthcareService-level parameters.
    expect(params?.extension?.some((e) => e.url === "service")).toBe(false);
    expect(params?.extension?.some((e) => e.url === "availability")).toBe(false);
  });

  it("schedule has exactly one actor and REQUIRED service + availability sub-extensions", () => {
    const s = buildSchedule({
      practitionerReference: "Practitioner/p1",
      healthcareServiceReference: "HealthcareService/hs1",
      durationMinutes: 30,
      availability: { daysOfWeek: ["mon", "tue"], startTime: "09:00:00", endTime: "17:00:00" },
    });
    expect(s.actor).toHaveLength(1);
    const params = s.extension?.find((e) => e.url === SCHEDULING_PARAMETERS_URL);
    expect(params?.extension?.find((e) => e.url === "service")?.valueReference?.reference).toBe(
      "HealthcareService/hs1",
    );
    const availability = params?.extension?.find((e) => e.url === "availability");
    const availableTime = availability?.extension?.find((e) => e.url === "availableTime");
    const days = availableTime?.extension?.filter((e) => e.url === "daysOfWeek") ?? [];
    expect(days.map((d) => d.valueCode)).toEqual(["mon", "tue"]);
    expect(availableTime?.extension?.find((e) => e.url === "availableStartTime")?.valueTime).toBe(
      "09:00:00",
    );
  });
});

describe("findSlots", () => {
  it("GETs the instance-level $find with required query params and unwraps the Bundle", async () => {
    const get = vi.fn().mockResolvedValue({
      resourceType: "Bundle",
      type: "searchset",
      entry: [{ resource: { resourceType: "Slot", start: "s", end: "e", status: "free" } }],
    });
    const slots = await findSlots(
      { get, post: vi.fn() },
      {
        scheduleId: "sched-1",
        healthcareServiceReference: "HealthcareService/hs1",
        start: "2026-07-06T00:00:00Z",
        end: "2026-07-07T00:00:00Z",
      },
    );
    expect(slots).toHaveLength(1);
    const url = String(get.mock.calls[0]![0]);
    expect(url).toContain("fhir/R4/Schedule/sched-1/$find?");
    expect(url).toContain("service-type-reference=HealthcareService%2Fhs1");
    expect(url).toContain("start=2026-07-06");
  });
});

describe("bookAppointment", () => {
  const slot = {
    start: "2026-07-06T14:00:00Z",
    end: "2026-07-06T14:30:00Z",
    scheduleReference: "Schedule/sched-1",
  };

  it("POSTs a Parameters body with the proposed free Slot and patient-reference", async () => {
    const post = vi.fn().mockResolvedValue({
      resourceType: "Bundle",
      entry: [
        {
          resource: { resourceType: "Appointment", id: "appt-1", start: slot.start, end: slot.end },
        },
        { resource: { resourceType: "Slot", status: "busy" } },
      ],
    });
    const result = await bookAppointment(
      { get: vi.fn(), post },
      { slot, serviceCode: "svc-botox", patientReference: "Patient/p1" },
    );
    expect(result).toEqual({ appointmentId: "appt-1", start: slot.start, end: slot.end });
    const [url, body] = post.mock.calls[0]! as [string, { parameter: unknown[] }];
    expect(url).toBe("fhir/R4/Appointment/$book");
    const params = body.parameter as {
      name: string;
      resource?: { status?: string; serviceType?: unknown };
      valueReference?: { reference: string };
    }[];
    expect(params.find((p) => p.name === "slot")?.resource?.status).toBe("free");
    expect(params.find((p) => p.name === "patient-reference")?.valueReference?.reference).toBe(
      "Patient/p1",
    );
  });

  it("maps the server's conflict OperationOutcome (409) to SlotTakenError", async () => {
    // The REAL error shape MedplumClient throws: an OperationOutcomeError whose outcome
    // is a conflict (isConflict) — never a message to be string-matched.
    const conflict = new OperationOutcomeError({
      resourceType: "OperationOutcome",
      id: "conflict",
      issue: [
        {
          severity: "error",
          code: "conflict",
          details: { text: "Requested time slot is no longer available" },
        },
      ],
    });
    const post = vi.fn().mockRejectedValue(conflict);
    await expect(
      bookAppointment({ get: vi.fn(), post }, { slot, serviceCode: "svc-botox" }),
    ).rejects.toBeInstanceOf(SlotTakenError);
  });

  it("does NOT map non-conflict errors to SlotTakenError (no message sniffing)", async () => {
    const post = vi.fn().mockRejectedValue(new Error("something mentioning 409 unrelatedly"));
    await expect(
      bookAppointment({ get: vi.fn(), post }, { slot, serviceCode: "svc-botox" }),
    ).rejects.toThrow(/unrelatedly/);
  });

  it("throws plainly when the Bundle carries no Appointment", async () => {
    const post = vi.fn().mockResolvedValue({ resourceType: "Bundle", entry: [] });
    await expect(
      bookAppointment({ get: vi.fn(), post }, { slot, serviceCode: "svc-botox" }),
    ).rejects.toThrow(/no Appointment/);
  });
});
