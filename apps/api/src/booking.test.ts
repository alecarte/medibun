import { SlotTakenError, TIMEZONE_EXTENSION_URL } from "@medibun/medplum-backend";
import { describe, expect, it, vi } from "vitest";

import {
  createBookingService,
  InvalidSlotError,
  UnknownScheduleError,
  UnknownServiceError,
} from "./booking.js";
import type { ServiceRow } from "./services/catalog.js";

const NOW = new Date("2026-07-06T12:00:00.000Z");

const botox: ServiceRow = {
  id: "botox-standard",
  code: "svc-botox",
  name: "Botox",
  description: "Smooths dynamic lines.",
  durationMinutes: 30,
  priceCents: 39_500,
  categoryColor: "sage",
  healthcareServiceId: "hs-1",
  stripeProductId: null,
  active: true,
  createdAt: NOW,
};

/** A searchset with one schedule + included practitioner, as Medplum returns it. */
const scheduleBundle = {
  resourceType: "Bundle",
  type: "searchset",
  entry: [
    {
      search: { mode: "match" },
      resource: {
        resourceType: "Schedule",
        id: "sched-1",
        actor: [{ reference: "Practitioner/p1" }],
      },
    },
    {
      search: { mode: "include" },
      resource: {
        resourceType: "Practitioner",
        id: "p1",
        name: [{ given: ["Riley"], family: "Reyes" }],
        extension: [{ url: TIMEZONE_EXTENSION_URL, valueCode: "America/New_York" }],
      },
    },
  ],
};

const freeSlot = (start: string, end: string) => ({
  resourceType: "Bundle",
  type: "searchset",
  entry: [{ resource: { resourceType: "Slot", status: "free", start, end } }],
});

type FhirGet = (url: string) => Promise<unknown>;
type FhirPost = (url: string, body?: unknown, contentType?: string) => Promise<unknown>;

function makeService(opts: { rows?: ServiceRow[]; get?: FhirGet; post?: FhirPost }) {
  const rows = opts.rows ?? [botox];
  const get = opts.get ?? vi.fn<FhirGet>();
  const post = opts.post ?? vi.fn<FhirPost>();
  const service = createBookingService({
    catalog: {
      listActive: () => Promise.resolve(rows.filter((r) => r.active)),
      getByCode: (code) => Promise.resolve(rows.find((r) => r.code === code)),
    },
    getFhirClient: () => Promise.resolve({ get, post }),
    now: () => NOW,
  });
  return { service, get, post };
}

describe("listServices", () => {
  it("maps active catalog rows to the domain DTO (no db internals leak)", async () => {
    const { service } = makeService({});
    await expect(service.listServices()).resolves.toEqual([
      {
        code: "svc-botox",
        name: "Botox",
        description: "Smooths dynamic lines.",
        durationMinutes: 30,
        priceCents: 39_500,
        categoryColor: "sage",
      },
    ]);
  });
});

describe("getAvailability", () => {
  it("fans $find out per schedule and groups slots by practitioner", async () => {
    const get = vi.fn<FhirGet>().mockImplementation((url) => {
      if (url.startsWith("fhir/R4/Schedule?")) {
        return Promise.resolve(scheduleBundle);
      }
      return Promise.resolve(freeSlot("2026-07-07T14:00:00.000Z", "2026-07-07T14:30:00.000Z"));
    });
    const { service } = makeService({ get });
    const availability = await service.getAvailability("svc-botox");
    expect(availability).toEqual({
      serviceCode: "svc-botox",
      practitioners: [
        {
          scheduleId: "sched-1",
          practitionerId: "p1",
          practitionerName: "Riley Reyes",
          timezone: "America/New_York",
          slots: [{ start: "2026-07-07T14:00:00.000Z", end: "2026-07-07T14:30:00.000Z" }],
        },
      ],
    });
    // The $find fan-out queries the service's HealthcareService over a 7-day window.
    const findUrl = String(
      get.mock.calls.map((c) => String(c[0])).find((u) => u.includes("$find")),
    );
    expect(findUrl).toContain("Schedule/sched-1/$find");
    expect(findUrl).toContain(encodeURIComponent("HealthcareService/hs-1"));
    expect(findUrl).toContain(encodeURIComponent(NOW.toISOString()));
  });

  it("throws UnknownServiceError for a code that is not on the active menu", async () => {
    const { service } = makeService({ rows: [{ ...botox, active: false }] });
    await expect(service.getAvailability("svc-botox")).rejects.toBeInstanceOf(UnknownServiceError);
  });

  it("throws UnknownServiceError when the catalog row has no FHIR counterpart yet", async () => {
    const { service } = makeService({ rows: [{ ...botox, healthcareServiceId: null }] });
    await expect(service.getAvailability("svc-botox")).rejects.toBeInstanceOf(UnknownServiceError);
  });
});

describe("book", () => {
  const bookedBundle = {
    resourceType: "Bundle",
    entry: [
      {
        resource: {
          resourceType: "Appointment",
          id: "appt-1",
          start: "2026-07-07T14:00:00.000Z",
          end: "2026-07-07T14:30:00.000Z",
        },
      },
    ],
  };

  it("re-derives the schedule server-side and books with the session patient", async () => {
    const get = vi.fn<FhirGet>().mockResolvedValue(scheduleBundle);
    const post = vi.fn<FhirPost>().mockResolvedValue(bookedBundle);
    const { service } = makeService({ get, post });
    const booked = await service.book("Patient/synth-1", {
      serviceCode: "svc-botox",
      scheduleId: "sched-1",
      start: "2026-07-07T14:00:00.000Z",
    });
    expect(booked).toEqual({
      id: "appt-1",
      serviceCode: "svc-botox",
      serviceName: "Botox",
      practitionerName: "Riley Reyes",
      start: "2026-07-07T14:00:00.000Z",
      end: "2026-07-07T14:30:00.000Z",
    });
    const [, body] = post.mock.calls[0]! as [string, { parameter: unknown[] }];
    const params = body.parameter as {
      name: string;
      resource?: { start?: string; end?: string; schedule?: { reference?: string } };
      valueReference?: { reference?: string };
    }[];
    const slot = params.find((p) => p.name === "slot")?.resource;
    // The end is computed server-side from the catalog duration — never client-supplied.
    expect(slot?.end).toBe("2026-07-07T14:30:00.000Z");
    expect(slot?.schedule?.reference).toBe("Schedule/sched-1");
    expect(params.find((p) => p.name === "patient-reference")?.valueReference?.reference).toBe(
      "Patient/synth-1",
    );
  });

  it("rejects a schedule that does not offer the service (crafted request)", async () => {
    const get = vi.fn<FhirGet>().mockResolvedValue(scheduleBundle);
    const { service } = makeService({ get });
    await expect(
      service.book("Patient/synth-1", {
        serviceCode: "svc-botox",
        scheduleId: "sched-other",
        start: "2026-07-07T14:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(UnknownScheduleError);
  });

  it("rejects an unparseable start", async () => {
    const { service } = makeService({});
    await expect(
      service.book("Patient/synth-1", {
        serviceCode: "svc-botox",
        scheduleId: "sched-1",
        start: "not-a-date",
      }),
    ).rejects.toBeInstanceOf(InvalidSlotError);
  });

  it("rejects a start in the past", async () => {
    const { service } = makeService({});
    await expect(
      service.book("Patient/synth-1", {
        serviceCode: "svc-botox",
        scheduleId: "sched-1",
        start: "2026-07-06T09:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(InvalidSlotError);
  });

  it("lets SlotTakenError propagate for the route's 409 mapping", async () => {
    const get = vi.fn<FhirGet>().mockResolvedValue(scheduleBundle);
    const post = vi.fn<FhirPost>().mockRejectedValue(new SlotTakenError());
    const { service } = makeService({ get, post });
    await expect(
      service.book("Patient/synth-1", {
        serviceCode: "svc-botox",
        scheduleId: "sched-1",
        start: "2026-07-07T14:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(SlotTakenError);
  });

  it("throws UnknownServiceError for an unknown code, even when the FHIR side also fails", async () => {
    // Catalog + schedule search run in parallel; the service error must win
    // deterministically so the route's 400/404 semantics never depend on timing.
    const get = vi.fn<FhirGet>().mockRejectedValue(new Error("medplum down"));
    const { service } = makeService({ get });
    await expect(
      service.book("Patient/synth-1", {
        serviceCode: "svc-nope",
        scheduleId: "sched-1",
        start: "2026-07-07T14:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(UnknownServiceError);
  });

  it("hides catalog rows without a FHIR counterpart from the menu (they cannot book)", async () => {
    const { service } = makeService({
      rows: [botox, { ...botox, id: "new-svc", code: "svc-new", healthcareServiceId: null }],
    });
    const services = await service.listServices();
    expect(services.map((s) => s.code)).toEqual(["svc-botox"]);
  });
});
