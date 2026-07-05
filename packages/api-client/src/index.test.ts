import { describe, it, expect } from "vitest";
import {
  BookingError,
  createApiClient,
  LoginError,
  StaffError,
  type DaySheet,
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

describe("staff endpoints", () => {
  const sheet: DaySheet = {
    date: "2026-07-04",
    timezone: "America/New_York",
    practitioners: [{ practitionerId: "pr1", practitionerName: "Riley Reyes" }],
    appointments: [
      {
        id: "a1",
        practitionerId: "pr1",
        patientId: "pt1",
        patientName: "Synthia Loginsmith",
        start: "2026-07-04T14:00:00.000Z",
        end: "2026-07-04T14:30:00.000Z",
        status: "scheduled",
        firstVisit: true,
      },
    ],
  };

  it("getStaffProfile GETs /staff/me with the forwarded cookie", async () => {
    const { fetchImpl, calls } = stubFetch(200, { id: "pr1", name: "Riley Reyes" });
    const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    await expect(client.getStaffProfile({ cookie: "medibun_session=x" })).resolves.toEqual({
      id: "pr1",
      name: "Riley Reyes",
    });
    expect(calls[0]!.url).toBe("https://api.example.test/staff/me");
    expect((calls[0]!.init?.headers as Record<string, string>).cookie).toBe("medibun_session=x");
  });

  it("getStaffProfile resolves undefined on 401 and 404 (benign signed-out states)", async () => {
    for (const status of [401, 404]) {
      const { fetchImpl } = stubFetch(status, { error: "x", requestId: "r" });
      const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
      await expect(client.getStaffProfile()).resolves.toBeUndefined();
    }
  });

  it("getDaySheet GETs /staff/schedule (no date = today) and returns the sheet", async () => {
    const { fetchImpl, calls } = stubFetch(200, sheet);
    const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    await expect(client.getDaySheet(undefined, { sessionToken: "tok" })).resolves.toEqual(sheet);
    expect(calls[0]!.url).toBe("https://api.example.test/staff/schedule");
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("getDaySheet passes an explicit date as the query param", async () => {
    const { fetchImpl, calls } = stubFetch(200, sheet);
    const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    await client.getDaySheet("2026-07-06", { sessionToken: "tok" });
    expect(calls[0]!.url).toBe("https://api.example.test/staff/schedule?date=2026-07-06");
  });

  it("getDaySheet throws a typed StaffError with the backend code", async () => {
    const { fetchImpl } = stubFetch(403, { error: "forbidden", requestId: "r" });
    const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    const err = await client.getDaySheet().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaffError);
    expect((err as StaffError).code).toBe("forbidden");
  });

  it("setAppointmentStatus POSTs the new status and URL-encodes the id", async () => {
    const { fetchImpl, calls } = stubFetch(200, { id: "a/1", status: "arrived" });
    const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    await expect(client.setAppointmentStatus("a/1", "arrived")).resolves.toEqual({
      id: "a/1",
      status: "arrived",
    });
    expect(calls[0]!.url).toBe("https://api.example.test/staff/appointments/a%2F1/status");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ status: "arrived" });
  });

  it("setAppointmentStatus maps a 409 to the conflict code (refetch, don't clobber)", async () => {
    const { fetchImpl } = stubFetch(409, { error: "conflict", requestId: "r" });
    const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    const err = await client.setAppointmentStatus("a1", "arrived").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaffError);
    expect((err as StaffError).code).toBe("conflict");
  });
});
