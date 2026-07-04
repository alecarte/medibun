import type { MedplumClient } from "@medplum/core";
import type { Appointment, Encounter } from "@medplum/fhirtypes";
import { describe, expect, it, vi } from "vitest";

import { handler } from "./check-in.bot.js";

const appointment = (status: Appointment["status"]): Appointment => ({
  resourceType: "Appointment",
  id: "appt-1",
  status,
  participant: [
    { actor: { reference: "Patient/pt1" }, status: "accepted" },
    { actor: { reference: "Practitioner/pr1" }, status: "accepted" },
  ],
  serviceType: [{ coding: [{ system: "x", code: "svc-botox" }] }],
});

const fakeMedplum = (existing: Encounter[]) => {
  const searchResources = vi.fn().mockResolvedValue(existing);
  const createResource = vi.fn().mockImplementation((r: Encounter) => Promise.resolve(r));
  const updateResource = vi.fn().mockImplementation((r: Encounter) => Promise.resolve(r));
  return {
    client: { searchResources, createResource, updateResource } as unknown as MedplumClient,
    searchResources,
    createResource,
    updateResource,
  };
};

const event = (input: Appointment) => ({ input }) as unknown as Parameters<typeof handler>[1];

describe("check-in bot", () => {
  it("creates the Encounter when the appointment arrives (front desk has no Encounter write)", async () => {
    const { client, searchResources, createResource } = fakeMedplum([]);
    await handler(client, event(appointment("arrived")));
    expect(searchResources).toHaveBeenCalledWith("Encounter", {
      appointment: "Appointment/appt-1",
      _count: "100",
    });
    const created = createResource.mock.calls[0]![0] as Encounter;
    expect(created.resourceType).toBe("Encounter");
    expect(created.status).toBe("arrived");
    expect(created.subject?.reference).toBe("Patient/pt1");
    expect(created.appointment?.[0]?.reference).toBe("Appointment/appt-1");
    expect(created.class.code).toBe("AMB");
    expect(created.serviceType?.coding?.[0]?.code).toBe("svc-botox");
  });

  it("is idempotent: a live Encounter means no second one (redelivery, second station)", async () => {
    const live: Encounter = {
      resourceType: "Encounter",
      id: "enc-1",
      status: "arrived",
      class: { code: "AMB" },
    };
    const { client, createResource } = fakeMedplum([live]);
    await handler(client, event(appointment("arrived")));
    expect(createResource).not.toHaveBeenCalled();
  });

  it("voids the live Encounter when a check-in is undone (booked again)", async () => {
    const live: Encounter = {
      resourceType: "Encounter",
      id: "enc-1",
      status: "arrived",
      class: { code: "AMB" },
    };
    const { client, updateResource, createResource } = fakeMedplum([live]);
    await handler(client, event(appointment("booked")));
    expect(updateResource).toHaveBeenCalledWith({ ...live, status: "entered-in-error" });
    expect(createResource).not.toHaveBeenCalled();
  });

  it("treats a fresh booking (no Encounter yet) as a no-op", async () => {
    const { client, updateResource, createResource } = fakeMedplum([]);
    await handler(client, event(appointment("booked")));
    expect(updateResource).not.toHaveBeenCalled();
    expect(createResource).not.toHaveBeenCalled();
  });

  it("re-checking in after an undo creates a NEW Encounter (voided one stays voided)", async () => {
    const voided: Encounter = {
      resourceType: "Encounter",
      id: "enc-1",
      status: "entered-in-error",
      class: { code: "AMB" },
    };
    const { client, createResource } = fakeMedplum([voided]);
    await handler(client, event(appointment("arrived")));
    expect(createResource).toHaveBeenCalledOnce();
  });
});
