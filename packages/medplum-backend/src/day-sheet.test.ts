import { conflict, forbidden, OperationOutcomeError, unauthorized } from "@medplum/core";
import type { Bundle } from "@medplum/fhirtypes";
import { describe, expect, it, vi } from "vitest";

import {
  ForbiddenError,
  hasAppointmentBefore,
  listDayAppointments,
  listSchedules,
  StatusConflictError,
  updateAppointmentStatus,
} from "./day-sheet.js";
import { SessionExpiredError } from "./patients.js";

const emptyBundle: Bundle = { resourceType: "Bundle", type: "searchset" };

describe("listSchedules", () => {
  it("requests every schedule with its actor included and maps the pairs", async () => {
    const bundle: Bundle = {
      resourceType: "Bundle",
      type: "searchset",
      entry: [
        {
          resource: {
            resourceType: "Schedule",
            id: "s1",
            actor: [{ reference: "Practitioner/p1" }],
          },
        },
        { resource: { resourceType: "Practitioner", id: "p1", name: [{ family: "Reyes" }] } },
      ],
    };
    const get = vi.fn().mockResolvedValue(bundle);
    const result = await listSchedules({ get, post: vi.fn() });
    expect(get).toHaveBeenCalledWith("fhir/R4/Schedule?_include=Schedule%3Aactor&_count=1000");
    expect(result).toHaveLength(1);
    expect(result[0]?.practitioner?.id).toBe("p1");
  });

  it("maps a 403 to ForbiddenError (the AccessPolicy speaking)", async () => {
    const get = vi.fn().mockRejectedValue(new OperationOutcomeError(forbidden));
    await expect(listSchedules({ get, post: vi.fn() })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("listDayAppointments", () => {
  it("bounds the search to [start, end) and splits included actors by type", async () => {
    const bundle: Bundle = {
      resourceType: "Bundle",
      type: "searchset",
      entry: [
        {
          resource: {
            resourceType: "Appointment",
            id: "a1",
            status: "booked",
            participant: [{ actor: { reference: "Patient/pt1" }, status: "accepted" }],
          },
        },
        { resource: { resourceType: "Patient", id: "pt1", name: [{ family: "Tan" }] } },
        { resource: { resourceType: "Practitioner", id: "pr1" } },
      ],
    };
    const get = vi.fn().mockResolvedValue(bundle);
    const result = await listDayAppointments(
      { get, post: vi.fn() },
      { start: "2026-07-04T04:00:00.000Z", end: "2026-07-05T04:00:00.000Z" },
    );
    const url = (get.mock.calls[0] as string[])[0]!;
    expect(url).toContain("date=ge2026-07-04T04%3A00%3A00.000Z");
    expect(url).toContain("date=lt2026-07-05T04%3A00%3A00.000Z");
    expect(url).toContain("_include=Appointment%3Aactor");
    expect(result.appointments.map((a) => a.id)).toEqual(["a1"]);
    expect(result.patients.get("Patient/pt1")?.id).toBe("pt1");
    expect(result.practitioners.get("Practitioner/pr1")?.id).toBe("pr1");
  });

  it("maps a 401 to SessionExpiredError (re-authenticate, not 500)", async () => {
    const get = vi.fn().mockRejectedValue(new OperationOutcomeError(unauthorized));
    await expect(
      listDayAppointments({ get, post: vi.fn() }, { start: "a", end: "b" }),
    ).rejects.toBeInstanceOf(SessionExpiredError);
  });
});

describe("hasAppointmentBefore", () => {
  it("asks for one prior non-cancelled, non-voided appointment", async () => {
    const get = vi.fn().mockResolvedValue(emptyBundle);
    const result = await hasAppointmentBefore(
      { get, post: vi.fn() },
      "Patient/pt1",
      "2026-07-04T04:00:00.000Z",
    );
    const url = (get.mock.calls[0] as string[])[0]!;
    expect(url).toContain("patient=Patient%2Fpt1");
    expect(url).toContain("date=lt2026-07-04T04%3A00%3A00.000Z");
    expect(url).toContain("_count=1");
    expect(url).toContain("status%3Anot=cancelled");
    expect(url).toContain("status%3Anot=entered-in-error");
    expect(result).toBe(false);
  });

  it("resolves true when any prior appointment exists", async () => {
    const bundle: Bundle = {
      resourceType: "Bundle",
      type: "searchset",
      entry: [
        {
          resource: { resourceType: "Appointment", id: "a0", status: "fulfilled", participant: [] },
        },
      ],
    };
    const get = vi.fn().mockResolvedValue(bundle);
    await expect(hasAppointmentBefore({ get, post: vi.fn() }, "Patient/pt1", "x")).resolves.toBe(
      true,
    );
  });
});

describe("updateAppointmentStatus", () => {
  it("test-and-sets the status via JSONPatch (atomic against other stations)", async () => {
    const patched = { resourceType: "Appointment" as const, id: "a1", status: "arrived" as const };
    const patchResource = vi.fn().mockResolvedValue(patched);
    const result = await updateAppointmentStatus(
      { patchResource },
      { id: "a1", from: "booked", to: "arrived" },
    );
    expect(patchResource).toHaveBeenCalledWith("Appointment", "a1", [
      { op: "test", path: "/status", value: "booked" },
      { op: "replace", path: "/status", value: "arrived" },
    ]);
    expect(result).toBe(patched);
  });

  it("maps a failed test op to StatusConflictError", async () => {
    const patchResource = vi.fn().mockRejectedValue(new OperationOutcomeError(conflict("taken")));
    await expect(
      updateAppointmentStatus({ patchResource }, { id: "a1", from: "booked", to: "arrived" }),
    ).rejects.toBeInstanceOf(StatusConflictError);
  });

  it("maps a 403 to ForbiddenError", async () => {
    const patchResource = vi.fn().mockRejectedValue(new OperationOutcomeError(forbidden));
    await expect(
      updateAppointmentStatus({ patchResource }, { id: "a1", from: "booked", to: "arrived" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
