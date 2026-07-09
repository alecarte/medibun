import { describe, it, expect } from "vitest";
import {
  APPOINTMENT_STATUSES,
  BookingError,
  createApiClient,
  FORWARD_TRANSITIONS,
  isValidDateString,
  isValidWallTime,
  LoginError,
  StaffError,
  STATUS_TRANSITIONS,
  weekStart,
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
    days: 1,
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
    events: [],
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

  it("getDaySheet passes date and days as query params (week view)", async () => {
    const { fetchImpl, calls } = stubFetch(200, sheet);
    const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    await client.getDaySheet({ date: "2026-07-06", days: 7 }, { sessionToken: "tok" });
    expect(calls[0]!.url).toBe("https://api.example.test/staff/schedule?date=2026-07-06&days=7");
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

  it("rescheduleAppointment POSTs the practice-local move and returns the new window", async () => {
    const moved = {
      id: "a1",
      practitionerId: "pr2",
      start: "2026-07-06T19:15:00.000Z",
      end: "2026-07-06T19:45:00.000Z",
    };
    const { fetchImpl, calls } = stubFetch(200, moved);
    const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    await expect(
      client.rescheduleAppointment(
        "a/1",
        { date: "2026-07-06", startTime: "15:15", practitionerId: "pr2" },
        { sessionToken: "tok" },
      ),
    ).resolves.toEqual(moved);
    expect(calls[0]!.url).toBe("https://api.example.test/staff/appointments/a%2F1/reschedule");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      date: "2026-07-06",
      startTime: "15:15",
      practitionerId: "pr2",
    });
  });

  it("rescheduleAppointment maps a 409 to conflict (taken window / lost race)", async () => {
    const { fetchImpl } = stubFetch(409, { error: "conflict", requestId: "r" });
    const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    const err = await client
      .rescheduleAppointment("a1", {
        date: "2026-07-06",
        startTime: "15:15",
        practitionerId: "pr1",
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaffError);
    expect((err as StaffError).code).toBe("conflict");
  });

  it("createInternalEvent POSTs /staff/events and returns the created event", async () => {
    const event = {
      id: "ev1",
      type: "meeting",
      title: "Team huddle",
      practitionerIds: ["pr1", "pr2"],
      start: "2026-07-06T16:00:00.000Z",
      end: "2026-07-06T16:30:00.000Z",
    };
    const { fetchImpl, calls } = stubFetch(201, event);
    const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    await expect(
      client.createInternalEvent(
        {
          type: "meeting",
          title: "Team huddle",
          practitionerIds: ["pr1", "pr2"],
          date: "2026-07-06",
          startTime: "12:00",
          endTime: "12:30",
        },
        { sessionToken: "tok" },
      ),
    ).resolves.toEqual(event);
    expect(calls[0]!.url).toBe("https://api.example.test/staff/events");
    expect(calls[0]!.init?.method).toBe("POST");
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("createInternalEvent throws a typed StaffError with the backend code", async () => {
    const { fetchImpl } = stubFetch(400, { error: "invalid_request", requestId: "r" });
    const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    const err = await client
      .createInternalEvent({
        type: "block",
        practitionerIds: ["pr1"],
        date: "2026-07-07",
        allDay: true,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaffError);
    expect((err as StaffError).code).toBe("invalid_request");
  });

  it("deleteInternalEvent DELETEs /staff/events/:id (URL-encoded) and resolves void", async () => {
    const { fetchImpl, calls } = stubFetch(200, { ok: true });
    const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    await expect(client.deleteInternalEvent("ev/1")).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe("https://api.example.test/staff/events/ev%2F1");
    expect(calls[0]!.init?.method).toBe("DELETE");
  });

  it("deleteInternalEvent maps a 404 to not_found (already gone — caller decides)", async () => {
    const { fetchImpl } = stubFetch(404, { error: "not_found", requestId: "r" });
    const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    const err = await client.deleteInternalEvent("ev1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaffError);
    expect((err as StaffError).code).toBe("not_found");
  });

  it("cancelAppointment POSTs the coded reason and returns the match cue", async () => {
    const cancelled = { id: "a1", status: "cancelled", moveUpMatches: 2 };
    const { fetchImpl, calls } = stubFetch(200, cancelled);
    const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    await expect(client.cancelAppointment("a/1", "patient")).resolves.toEqual(cancelled);
    expect(calls[0]!.url).toBe("https://api.example.test/staff/appointments/a%2F1/cancel");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ reason: "patient" });
  });

  it("cancelAppointment maps a 409 to conflict (not scheduled anymore / lost race)", async () => {
    const { fetchImpl } = stubFetch(409, { error: "conflict", requestId: "r" });
    const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    const err = await client.cancelAppointment("a1", "practice").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaffError);
    expect((err as StaffError).code).toBe("conflict");
  });

  it("restoreAppointment POSTs the undo and returns the re-booked status", async () => {
    const { fetchImpl, calls } = stubFetch(200, { id: "a1", status: "scheduled" });
    const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    await expect(client.restoreAppointment("a1")).resolves.toEqual({
      id: "a1",
      status: "scheduled",
    });
    expect(calls[0]!.url).toBe("https://api.example.test/staff/appointments/a1/restore");
    expect(calls[0]!.init?.method).toBe("POST");
  });

  it("restoreAppointment maps a 409 to conflict (the freed window was taken)", async () => {
    const { fetchImpl } = stubFetch(409, { error: "conflict", requestId: "r" });
    const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    const err = await client.restoreAppointment("a1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaffError);
    expect((err as StaffError).code).toBe("conflict");
  });

  it("listMoveUp GETs /staff/move-up and unwraps the entries", async () => {
    const entry = {
      id: "m1",
      patientId: "pt1",
      patientName: "Synthia Loginsmith",
      appointmentId: "a1",
      serviceCode: "svc-botox",
      createdAt: "2026-07-09T12:00:00.000Z",
    };
    const { fetchImpl, calls } = stubFetch(200, { entries: [entry] });
    const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    await expect(client.listMoveUp({ sessionToken: "tok" })).resolves.toEqual([entry]);
    expect(calls[0]!.url).toBe("https://api.example.test/staff/move-up");
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("addMoveUp POSTs the request and returns the resolved entry", async () => {
    const entry = {
      id: "m1",
      patientId: "pt1",
      patientName: "Synthia Loginsmith",
      appointmentId: "a1",
      serviceCode: "svc-botox",
      practitionerId: "pr1",
      note: "mornings only",
      createdAt: "2026-07-09T12:00:00.000Z",
    };
    const { fetchImpl, calls } = stubFetch(201, entry);
    const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    await expect(
      client.addMoveUp({ appointmentId: "a1", practitionerId: "pr1", note: "mornings only" }),
    ).resolves.toEqual(entry);
    expect(calls[0]!.url).toBe("https://api.example.test/staff/move-up");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      appointmentId: "a1",
      practitionerId: "pr1",
      note: "mornings only",
    });
  });

  it("addMoveUp maps a 409 to conflict (already on the list)", async () => {
    const { fetchImpl } = stubFetch(409, { error: "conflict", requestId: "r" });
    const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    const err = await client.addMoveUp({ appointmentId: "a1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaffError);
    expect((err as StaffError).code).toBe("conflict");
  });

  it("resolveMoveUp PATCHes the terminal status and resolves void", async () => {
    const { fetchImpl, calls } = stubFetch(200, { id: "m1", status: "fulfilled" });
    const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    await expect(client.resolveMoveUp("m/1", "fulfilled")).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe("https://api.example.test/staff/move-up/m%2F1");
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ status: "fulfilled" });
  });

  it("resolveMoveUp maps a 404 to not_found (unknown or already resolved)", async () => {
    const { fetchImpl } = stubFetch(404, { error: "not_found", requestId: "r" });
    const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    const err = await client.resolveMoveUp("m1", "removed").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaffError);
    expect((err as StaffError).code).toBe("not_found");
  });
});

describe("schedule contract helpers (shared by BFF and staff app)", () => {
  it("weekStart snaps to the Monday of the week", () => {
    expect(weekStart("2026-07-08")).toBe("2026-07-06"); // Wed → Mon
    expect(weekStart("2026-07-06")).toBe("2026-07-06"); // Mon → itself
    expect(weekStart("2026-07-05")).toBe("2026-06-29"); // Sun → prior Mon
    expect(weekStart("2026-01-01")).toBe("2025-12-29"); // across a year boundary
  });

  it("isValidDateString accepts real calendar dates and rejects malformed or impossible ones", () => {
    expect(isValidDateString("2026-07-06")).toBe(true);
    expect(isValidDateString("2026-02-31")).toBe(false);
    expect(isValidDateString("tomorrow")).toBe(false);
    expect(isValidDateString("2026-7-6")).toBe(false);
  });

  it("isValidWallTime accepts 24h HH:mm and rejects out-of-range or malformed times", () => {
    expect(isValidWallTime("00:00")).toBe(true);
    expect(isValidWallTime("23:59")).toBe(true);
    expect(isValidWallTime("24:00")).toBe(false);
    expect(isValidWallTime("9:00")).toBe(false);
    expect(isValidWallTime("09:60")).toBe(false);
  });

  it("STATUS_TRANSITIONS is the forward graph plus each move's exact reverse (undo)", () => {
    expect(STATUS_TRANSITIONS.scheduled).toEqual(["arrived", "no-show"]);
    expect(STATUS_TRANSITIONS.arrived).toEqual(["roomed", "scheduled"]);
    expect(STATUS_TRANSITIONS.roomed).toEqual(["completed", "arrived"]);
    expect(STATUS_TRANSITIONS.completed).toEqual(["roomed"]);
    expect(STATUS_TRANSITIONS["no-show"]).toEqual(["scheduled"]);
  });

  it("FORWARD_TRANSITIONS covers every status and never moves backward", () => {
    expect(Object.keys(FORWARD_TRANSITIONS).sort()).toEqual([...APPOINTMENT_STATUSES].sort());
    expect(FORWARD_TRANSITIONS.completed).toEqual([]);
    expect(FORWARD_TRANSITIONS["no-show"]).toEqual([]);
  });
});
