// Stub BFF for portal screenshot review ONLY (synthetic data, mirrors seed-demo.ts).
// The real BFF booking chain is unit/contract-tested; live FHIR verify runs on the
// real stack. This exists because this container's network policy blocks Docker pulls.
import { createServer } from "node:http";
// The shared week-snap (same function the real BFF uses). Needs the package built:
// `pnpm --filter @medibun/api-client build`.
import { weekStart } from "../../packages/api-client/dist/index.js";

const SERVICES = [
  {
    code: "svc-botox",
    name: "Botox",
    description: "Smooths dynamic lines in the upper face.",
    durationMinutes: 30,
    priceCents: 39500,
    categoryColor: "sage",
  },
  {
    code: "svc-dysport",
    name: "Dysport",
    description: "A lighter-touch neuromodulator alternative.",
    durationMinutes: 30,
    priceCents: 37500,
    categoryColor: "teal",
  },
  {
    code: "svc-lip-filler",
    name: "Lip filler",
    description: "Shape and volume, kept subtle.",
    durationMinutes: 45,
    priceCents: 68000,
    categoryColor: "plum",
  },
];

// Weekday business-hour slots for the next 5 days, America/New_York-ish (UTC-4).
function slots(durationMin) {
  const out = [];
  const now = new Date();
  for (let d = 1; d <= 5 && out.length < 14; d++) {
    const day = new Date(now.getTime() + d * 86400000);
    if ([0, 6].includes(day.getUTCDay())) continue;
    for (const hourUtc of [13, 14, 15, 17, 18, 19]) {
      const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hourUtc, hourUtc % 2 ? 30 : 0));
      out.push({ start: start.toISOString(), end: new Date(start.getTime() + durationMin * 60000).toISOString() });
    }
  }
  return out;
}

const PRACTITIONER = {
  "svc-botox": { scheduleId: "sched-riley-botox", practitionerId: "prac-riley", practitionerName: "Riley Reyes" },
  "svc-dysport": { scheduleId: "sched-riley-dysport", practitionerId: "prac-riley", practitionerName: "Riley Reyes" },
  "svc-lip-filler": { scheduleId: "sched-maya-lip", practitionerId: "prac-maya", practitionerName: "Maya Chen" },
};

let failNextBook = false;
let failNextStatus = false;

// ---- Staff day sheet (S5) — synthetic, realistic-density day (DESIGN.md tenet 5:
// long names, every workflow status, missing contact edge, first visits). Times are
// minted for "today" so the sheet always looks alive. Statuses persist in memory so
// check-in / undo round-trips survive a router.refresh.
const dayStart = new Date();
dayStart.setUTCHours(13, 0, 0, 0); // 9:00 AM America/New_York (EDT)
const at = (minutes, durationMin) => ({
  start: new Date(dayStart.getTime() + minutes * 60000).toISOString(),
  end: new Date(dayStart.getTime() + (minutes + durationMin) * 60000).toISOString(),
});

const STAFF_APPOINTMENTS = [
  { id: "sa-1", practitionerId: "prac-riley", patientId: "pt-1", patientName: "Synthia Loginsmith", patientPhone: "555-010-0100", patientEmail: "synthia.login@example.test", serviceCode: "svc-botox", serviceName: "Botox", serviceColor: "sage", ...at(0, 30), status: "completed", firstVisit: false, bookedAt: new Date(dayStart.getTime() - 3 * 86400000).toISOString() },
  { id: "sa-2", practitionerId: "prac-riley", patientId: "pt-2", patientName: "Aurelia Vandermeer-Castellanos", patientPhone: "555-010-0135", patientEmail: "aurelia.vc@example.test", serviceCode: "svc-dysport", serviceName: "Dysport", serviceColor: "teal", ...at(45, 30), status: "roomed", firstVisit: false, bookedAt: new Date(dayStart.getTime() - 6 * 86400000).toISOString() },
  { id: "sa-3", practitionerId: "prac-riley", patientId: "pt-3", patientName: "Mei Nakamura-Okafor", patientPhone: "555-010-0177", patientEmail: "mei.no@example.test", serviceCode: "svc-botox", serviceName: "Botox", serviceColor: "sage", ...at(120, 30), status: "arrived", firstVisit: true, bookedAt: new Date(dayStart.getTime() - 86400000).toISOString() },
  { id: "sa-4", practitionerId: "prac-riley", patientId: "pt-4", patientName: "Jo Park", serviceCode: "svc-dysport", serviceName: "Dysport", serviceColor: "teal", ...at(210, 30), status: "scheduled", firstVisit: false, bookedAt: new Date(dayStart.getTime() - 2 * 86400000).toISOString() },
  { id: "sa-5", practitionerId: "prac-riley", patientId: "pt-5", patientName: "Valentina Ruiz de la Torre", patientPhone: "555-010-0142", patientEmail: "valentina.rt@example.test", serviceCode: "svc-botox", serviceName: "Botox", serviceColor: "sage", ...at(300, 30), status: "scheduled", firstVisit: true, bookedAt: dayStart.toISOString() },
  { id: "sa-6", practitionerId: "prac-riley", patientId: "pt-6", patientName: "Hannah Osei", patientPhone: "555-010-0163", patientEmail: "hannah.osei@example.test", serviceCode: "svc-botox", serviceName: "Botox", serviceColor: "sage", ...at(390, 30), status: "no-show", firstVisit: false, bookedAt: new Date(dayStart.getTime() - 5 * 86400000).toISOString() },
  { id: "sa-7", practitionerId: "prac-maya", patientId: "pt-7", patientName: "Priya Raghunathan", patientPhone: "555-010-0128", patientEmail: "priya.r@example.test", serviceCode: "svc-lip-filler", serviceName: "Lip filler", serviceColor: "plum", ...at(30, 45), status: "completed", firstVisit: false, bookedAt: new Date(dayStart.getTime() - 8 * 86400000).toISOString() },
  { id: "sa-8", practitionerId: "prac-maya", patientId: "pt-8", patientName: "Camille Beaumont-Ledoux", patientPhone: "555-010-0151", patientEmail: "camille.bl@example.test", serviceCode: "svc-lip-filler", serviceName: "Lip filler", serviceColor: "plum", ...at(150, 45), status: "arrived", firstVisit: true, bookedAt: new Date(dayStart.getTime() - 86400000).toISOString() },
  { id: "sa-9", practitionerId: "prac-maya", patientId: "pt-9", patientName: "Grace Adeyemi-Thompson", patientPhone: "555-010-0119", patientEmail: "grace.at@example.test", serviceCode: "svc-lip-filler", serviceName: "Lip filler", serviceColor: "plum", ...at(270, 45), status: "scheduled", firstVisit: false, bookedAt: new Date(dayStart.getTime() - 4 * 86400000).toISOString() },
  { id: "sa-10", practitionerId: "prac-maya", patientId: "pt-10", patientName: "Sofia Marchetti", patientPhone: "555-010-0184", patientEmail: "sofia.m@example.test", serviceCode: "svc-lip-filler", serviceName: "Lip filler", serviceColor: "plum", ...at(420, 45), status: "scheduled", firstVisit: false, bookedAt: new Date(dayStart.getTime() - 2 * 86400000).toISOString() },
];
const staffStatuses = new Map(STAFF_APPOINTMENTS.map((a) => [a.id, a.status]));

// ---- Internal events (S5c): one seeded meeting (re-anchored like the appointments);
// creates/deletes persist in memory so the live-update poll shows them cross-station.
const SEED_EVENTS = [
  { id: "se-1", type: "meeting", title: "Team huddle", practitionerIds: ["prac-riley", "prac-maya"], ...at(240, 30) },
];
const deletedEventIds = new Set();
const createdEvents = []; // absolute instants — never re-anchored
let nextEventId = 1;

// Fixed EDT offset, consistent with the rest of this stub's clock math.
const stubInstant = (date, time) => new Date(`${date}T${time}:00-04:00`).toISOString();
const stubEventWindow = ({ type, date, startTime, endTime }) =>
  type === "day-off"
    ? {
        start: stubInstant(date, "00:00"),
        end: new Date(Date.parse(stubInstant(date, "00:00")) + 86400000).toISOString(),
      }
    : { start: stubInstant(date, startTime), end: stubInstant(date, endTime) };

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const signedIn = (req.headers.cookie ?? "").includes("medibun_session=");
  if (req.method === "POST" && url.pathname === "/auth/login") {
    return json(res, 200, { sessionToken: "stub-session" }, { "set-cookie": "medibun_session=stub-session; Path=/; HttpOnly" });
  }
  if (url.pathname === "/patients/me") {
    return signedIn
      ? json(res, 200, { id: "synth-1", name: "Synthia Loginsmith", birthDate: "1993-04-12" })
      : json(res, 401, { error: "unauthorized", requestId: "stub" });
  }
  if (url.pathname === "/staff/me") {
    return signedIn
      ? json(res, 200, { id: "prac-noor", name: "Noor Haddad" })
      : json(res, 401, { error: "unauthorized", requestId: "stub" });
  }
  if (!signedIn) return json(res, 401, { error: "unauthorized", requestId: "stub" });
  if (url.pathname === "/staff/schedule") {
    const requested = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
    const days = Number(url.searchParams.get("days") ?? "1");
    // Week view snaps to the week's Monday via the same shared weekStart as the real BFF.
    const date = days === 7 ? weekStart(requested) : requested;
    // Re-anchor the synthetic day onto the range start; for a week, spread the
    // appointments across the days so every column has content to review.
    const rangeStart = Date.parse(`${date}T13:00:00Z`); // 9:00 AM EDT
    const shift = rangeStart - dayStart.getTime();
    const appointments = STAFF_APPOINTMENTS.map((a, i) => {
      const dayOffset = (days > 1 ? i % days : 0) * 86400000;
      return {
        ...a,
        start: new Date(Date.parse(a.start) + shift + dayOffset).toISOString(),
        end: new Date(Date.parse(a.end) + shift + dayOffset).toISOString(),
        status: staffStatuses.get(a.id),
      };
    });
    const rangeEnd = rangeStart + days * 86400000;
    const events = [
      ...SEED_EVENTS.map((e) => ({
        ...e,
        start: new Date(Date.parse(e.start) + shift).toISOString(),
        end: new Date(Date.parse(e.end) + shift).toISOString(),
      })),
      ...createdEvents,
    ].filter(
      (e) =>
        !deletedEventIds.has(e.id) &&
        Date.parse(e.start) < rangeEnd &&
        Date.parse(e.end) > rangeStart - 86400000, // day-off starts at local midnight, before 9am rangeStart
    );
    return json(res, 200, {
      date,
      days,
      timezone: "America/New_York",
      practitioners: [
        { practitionerId: "prac-maya", practitionerName: "Maya Chen" },
        { practitionerId: "prac-riley", practitionerName: "Riley Reyes" },
      ],
      appointments,
      events,
    });
  }
  if (req.method === "POST" && url.pathname === "/staff/events") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const request = JSON.parse(body);
      const event = {
        id: `se-created-${++nextEventId}`,
        type: request.type,
        ...(request.title ? { title: request.title } : {}),
        practitionerIds: request.practitionerIds,
        ...stubEventWindow(request),
      };
      createdEvents.push(event);
      json(res, 201, event);
    });
    return;
  }
  const eventMatch = url.pathname.match(/^\/staff\/events\/([^/]+)$/);
  if (req.method === "DELETE" && eventMatch) {
    const id = decodeURIComponent(eventMatch[1]);
    const exists =
      (SEED_EVENTS.some((e) => e.id === id) && !deletedEventIds.has(id)) ||
      createdEvents.some((e) => e.id === id);
    if (!exists) return json(res, 404, { error: "not_found", requestId: "stub" });
    deletedEventIds.add(id);
    const created = createdEvents.findIndex((e) => e.id === id);
    if (created >= 0) createdEvents.splice(created, 1);
    res.writeHead(204);
    return res.end();
  }
  const statusMatch = url.pathname.match(/^\/staff\/appointments\/([^/]+)\/status$/);
  if (req.method === "POST" && statusMatch) {
    const id = decodeURIComponent(statusMatch[1]);
    if (!staffStatuses.has(id)) return json(res, 404, { error: "not_found", requestId: "stub" });
    if (failNextStatus) {
      // Cross-station conflict path (the real BFF's 409 contract) — arm via
      // POST /stub/fail-next-status to review the conflict notice + refresh flow.
      failNextStatus = false;
      return json(res, 409, { error: "conflict", requestId: "stub" });
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { status } = JSON.parse(body);
      staffStatuses.set(id, status);
      json(res, 200, { id, status });
    });
    return;
  }
  if (url.pathname === "/services") return json(res, 200, { services: SERVICES });
  const availability = url.pathname.match(/^\/services\/([^/]+)\/availability$/);
  if (availability) {
    const code = decodeURIComponent(availability[1]);
    const service = SERVICES.find((s) => s.code === code);
    if (!service) return json(res, 404, { error: "not_found", requestId: "stub" });
    return json(res, 200, {
      serviceCode: code,
      timezone: "America/New_York",
      windowStart: new Date().toISOString(),
      windowDays: 7,
      practitioners: [{ ...PRACTITIONER[code], slots: slots(service.durationMinutes) }],
    });
  }
  if (req.method === "POST" && url.pathname === "/appointments") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (failNextBook) {
        failNextBook = false;
        return json(res, 409, { error: "slot_taken", requestId: "stub" });
      }
      const { serviceCode, start } = JSON.parse(body);
      const service = SERVICES.find((s) => s.code === serviceCode);
      return json(res, 201, {
        id: "appt-stub-1",
        serviceCode,
        serviceName: service?.name ?? "?",
        practitionerName: PRACTITIONER[serviceCode]?.practitionerName ?? "?",
        start,
        end: new Date(Date.parse(start) + (service?.durationMinutes ?? 30) * 60000).toISOString(),
      });
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/stub/fail-next-book") {
    failNextBook = true;
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/stub/fail-next-status") {
    failNextStatus = true;
    return json(res, 200, { ok: true });
  }
  json(res, 404, { error: "not_found", requestId: "stub" });
}).listen(3001, () => console.log("stub BFF on 3001"));
