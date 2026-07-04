import { describe, it, expect } from "vitest";
import {
  BookingError,
  createApiClient,
  LoginError,
  type BookedAppointment,
  type PatientProfile,
  type ServiceAvailability,
  type ServiceSummary,
} from "./index.js";

/** Stub fetch returning a canned response; records the requests it received. */
function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetchImpl, calls };
}

const profile: PatientProfile = { id: "p1", name: "Synth Example", birthDate: "1990-01-01" };

describe("api-client", () => {
  it("creates a client pointed at our backend base URL", () => {
    const client = createApiClient({ baseUrl: "https://api.example.test" });
    expect(client.baseUrl).toBe("https://api.example.test");
  });

  describe("login", () => {
    it("POSTs credentials to /auth/login and returns the session token", async () => {
      const { fetchImpl, calls } = stubFetch(200, { sessionToken: "s-123" });
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      await expect(client.login("synthia@example.test", "pw")).resolves.toEqual({
        sessionToken: "s-123",
      });
      expect(calls[0]!.url).toBe("https://api.example.test/auth/login");
      expect(calls[0]!.init?.method).toBe("POST");
      expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
        email: "synthia@example.test",
        password: "pw",
      });
    });

    it("throws a typed LoginError carrying the backend error code on 401", async () => {
      const { fetchImpl } = stubFetch(401, { error: "invalid_credentials", requestId: "r" });
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      const err = await client.login("synthia@example.test", "bad").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LoginError);
      expect((err as LoginError).code).toBe("invalid_credentials");
    });

    it("maps rate limiting to its code", async () => {
      const { fetchImpl } = stubFetch(429, { error: "rate_limited", requestId: "r" });
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      const err = await client.login("a@b.test", "pw").catch((e: unknown) => e);
      expect((err as LoginError).code).toBe("rate_limited");
    });

    it("never includes the email or password in error messages", async () => {
      const { fetchImpl } = stubFetch(401, { error: "invalid_credentials", requestId: "r" });
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      const err = await client.login("secret@example.test", "hunter2").catch((e: unknown) => e);
      expect(String((err as Error).message)).not.toMatch(/secret@example\.test|hunter2/);
    });
  });

  describe("getMyProfile", () => {
    it("GETs /patients/me forwarding a cookie header (RSC server-side use)", async () => {
      const { fetchImpl, calls } = stubFetch(200, profile);
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      await expect(client.getMyProfile({ cookie: "medibun_session=abc" })).resolves.toEqual(
        profile,
      );
      expect(calls[0]!.url).toBe("https://api.example.test/patients/me");
      expect(new Headers(calls[0]!.init?.headers).get("cookie")).toBe("medibun_session=abc");
    });

    it("sends a bearer header when given a session token (mobile use)", async () => {
      const { fetchImpl, calls } = stubFetch(200, profile);
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      await client.getMyProfile({ sessionToken: "s-123" });
      expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer s-123");
    });

    it("resolves undefined on 401 (signed out / expired)", async () => {
      const { fetchImpl } = stubFetch(401, { error: "unauthenticated", requestId: "r" });
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      await expect(client.getMyProfile({ cookie: "medibun_session=x" })).resolves.toBeUndefined();
    });

    it("throws on other error statuses without including the response body", async () => {
      const { fetchImpl } = stubFetch(500, { error: "internal_error", requestId: "r" });
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      await expect(client.getMyProfile()).rejects.toThrow(/500/);
    });
  });

  describe("logout", () => {
    it("POSTs /auth/logout forwarding session auth and resolves on ok", async () => {
      const { fetchImpl, calls } = stubFetch(200, { ok: true });
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      await expect(client.logout({ cookie: "medibun_session=abc" })).resolves.toBeUndefined();
      expect(calls[0]!.url).toBe("https://api.example.test/auth/logout");
      expect(calls[0]!.init?.method).toBe("POST");
      expect(new Headers(calls[0]!.init?.headers).get("cookie")).toBe("medibun_session=abc");
    });

    it("throws generically on failure statuses", async () => {
      const { fetchImpl } = stubFetch(500, { error: "internal_error", requestId: "r" });
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      await expect(client.logout()).rejects.toThrow(/500/);
    });
  });
});

describe("booking", () => {
  const service: ServiceSummary = {
    code: "svc-botox",
    name: "Botox",
    description: "Smooths dynamic lines.",
    durationMinutes: 30,
    priceCents: 39_500,
    categoryColor: "sage",
  };
  const availability: ServiceAvailability = {
    serviceCode: "svc-botox",
    timezone: "America/New_York",
    windowStart: "2026-07-06T12:00:00.000Z",
    windowDays: 7,
    practitioners: [
      {
        scheduleId: "sched-1",
        practitionerId: "p1",
        practitionerName: "Riley Reyes",
        slots: [{ start: "2026-07-06T14:00:00.000Z", end: "2026-07-06T14:30:00.000Z" }],
      },
    ],
  };
  const booked: BookedAppointment = {
    id: "appt-1",
    serviceCode: "svc-botox",
    serviceName: "Botox",
    practitionerName: "Riley Reyes",
    start: "2026-07-06T14:00:00.000Z",
    end: "2026-07-06T14:30:00.000Z",
  };

  describe("listServices", () => {
    it("GETs /services with session auth and unwraps the list", async () => {
      const { fetchImpl, calls } = stubFetch(200, { services: [service] });
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      await expect(client.listServices({ cookie: "medibun_session=abc" })).resolves.toEqual([
        service,
      ]);
      expect(calls[0]!.url).toBe("https://api.example.test/services");
      expect(new Headers(calls[0]!.init?.headers).get("cookie")).toBe("medibun_session=abc");
    });

    it("throws a typed BookingError with unauthorized on 401", async () => {
      const { fetchImpl } = stubFetch(401, { error: "unauthorized", requestId: "r" });
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      const err = await client.listServices().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BookingError);
      expect((err as BookingError).code).toBe("unauthorized");
    });
  });

  describe("getAvailability", () => {
    it("GETs the service's availability with an encoded code", async () => {
      const { fetchImpl, calls } = stubFetch(200, availability);
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      await expect(client.getAvailability("svc-botox", { sessionToken: "s-123" })).resolves.toEqual(
        availability,
      );
      expect(calls[0]!.url).toBe("https://api.example.test/services/svc-botox/availability");
      expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer s-123");
    });

    it("maps an unknown service to a not_found BookingError", async () => {
      const { fetchImpl } = stubFetch(404, { error: "not_found", requestId: "r" });
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      const err = await client.getAvailability("svc-nope").catch((e: unknown) => e);
      expect((err as BookingError).code).toBe("not_found");
    });
  });

  describe("book", () => {
    const request = { serviceCode: "svc-botox", scheduleId: "sched-1", start: booked.start };

    it("POSTs the booking request and resolves the confirmed appointment", async () => {
      const { fetchImpl, calls } = stubFetch(201, booked);
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      await expect(client.book(request, { cookie: "medibun_session=abc" })).resolves.toEqual(
        booked,
      );
      expect(calls[0]!.url).toBe("https://api.example.test/appointments");
      expect(calls[0]!.init?.method).toBe("POST");
      expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(request);
      expect(new Headers(calls[0]!.init?.headers).get("cookie")).toBe("medibun_session=abc");
    });

    it("maps a 409 to slot_taken so the UI can re-pick calmly", async () => {
      const { fetchImpl } = stubFetch(409, { error: "slot_taken", requestId: "r" });
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      const err = await client.book(request).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BookingError);
      expect((err as BookingError).code).toBe("slot_taken");
    });

    it("maps unrecognized error bodies to unknown without leaking them", async () => {
      const { fetchImpl } = stubFetch(500, { error: "SENSITIVE-DETAIL", requestId: "r" });
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      const err = await client.book(request).catch((e: unknown) => e);
      expect((err as BookingError).code).toBe("unknown");
      expect(String((err as Error).message)).not.toContain("SENSITIVE-DETAIL");
    });
  });
});

describe("getMyProfile — benign not-found states", () => {
  it("resolves undefined on 404 (valid session, no resolvable patient profile)", async () => {
    const { fetchImpl } = stubFetch(404, { error: "not_found", requestId: "r" });
    const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    await expect(client.getMyProfile({ cookie: "medibun_session=x" })).resolves.toBeUndefined();
  });
});
