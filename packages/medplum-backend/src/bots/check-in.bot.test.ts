import { notFound, OperationOutcomeError } from "@medplum/core";
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

/** `current` is what the server holds NOW (the bot re-reads); omit to 404 the read. */
const fakeMedplum = (existing: Encounter[], current?: Appointment) => {
  const searchResources = vi.fn().mockResolvedValue(existing);
  const createResource = vi.fn().mockImplementation((r: Encounter) => Promise.resolve(r));
  const updateResource = vi.fn().mockImplementation((r: Encounter) => Promise.resolve(r));
  const readResource = vi
    .fn()
    .mockImplementation(() =>
      current ? Promise.resolve(current) : Promise.reject(new OperationOutcomeError(notFound)),
    );
  return {
    client: {
      searchResources,
      createResource,
      updateResource,
      readResource,
    } as unknown as MedplumClient,
    searchResources,
    createResource,
    updateResource,
    readResource,
  };
};

const event = (input: Appointment) => ({ input }) as unknown as Parameters<typeof handler>[1];

describe("check-in bot", () => {
  it("creates the Encounter when the appointment arrives (front desk has no Encounter write)", async () => {
    const { client, searchResources, createResource } = fakeMedplum([], appointment("arrived"));
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
    const { client, createResource } = fakeMedplum([live], appointment("arrived"));
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
    const { client, updateResource, createResource } = fakeMedplum([live], appointment("booked"));
    await handler(client, event(appointment("booked")));
    expect(updateResource).toHaveBeenCalledWith({ ...live, status: "entered-in-error" });
    expect(createResource).not.toHaveBeenCalled();
  });

  it("treats a fresh booking (no Encounter yet) as a no-op", async () => {
    const { client, updateResource, createResource } = fakeMedplum([], appointment("booked"));
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
    const { client, createResource } = fakeMedplum([voided], appointment("arrived"));
    await handler(client, event(appointment("arrived")));
    expect(createResource).toHaveBeenCalledOnce();
  });

  it("acts on the CURRENT status, not the event snapshot: stale 'arrived' after an undo", async () => {
    // Check-in then quick undo — the 'arrived' event delivered LAST must not resurrect
    // an Encounter for an appointment the server already moved back to 'booked'.
    const { client, createResource } = fakeMedplum([], appointment("booked"));
    await handler(client, event(appointment("arrived")));
    expect(createResource).not.toHaveBeenCalled();
  });

  it("acts on the CURRENT status, not the event snapshot: stale 'booked' after a re-check-in", async () => {
    // Undo then re-check-in — the 'booked' event delivered LAST must not void the live
    // Encounter of an appointment the server already moved back to 'arrived'.
    const live: Encounter = {
      resourceType: "Encounter",
      id: "enc-1",
      status: "arrived",
      class: { code: "AMB" },
    };
    const { client, updateResource, createResource } = fakeMedplum([live], appointment("arrived"));
    await handler(client, event(appointment("booked")));
    expect(updateResource).not.toHaveBeenCalled();
    expect(createResource).not.toHaveBeenCalled(); // a live Encounter already exists
  });

  it("does nothing when the appointment no longer exists", async () => {
    const { client, searchResources, createResource, updateResource } = fakeMedplum([]);
    await handler(client, event(appointment("arrived")));
    expect(searchResources).not.toHaveBeenCalled();
    expect(createResource).not.toHaveBeenCalled();
    expect(updateResource).not.toHaveBeenCalled();
  });

  it("rethrows a transient re-read failure so the Subscription retries", async () => {
    // Only not-found means "deleted". A 5xx/network/policy failure must NOT be treated
    // as success — swallowing it would silently skip Encounter reconciliation.
    const { client, readResource, createResource } = fakeMedplum([]);
    readResource.mockRejectedValueOnce(new Error("connect ETIMEDOUT"));
    await expect(handler(client, event(appointment("arrived")))).rejects.toThrow("ETIMEDOUT");
    expect(createResource).not.toHaveBeenCalled();
  });
});
