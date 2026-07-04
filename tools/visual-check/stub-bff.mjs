// Stub BFF for portal screenshot review ONLY (synthetic data, mirrors seed-demo.ts).
// The real BFF booking chain is unit/contract-tested; live FHIR verify runs on the
// real stack. This exists because this container's network policy blocks Docker pulls.
import { createServer } from "node:http";

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
  if (!signedIn) return json(res, 401, { error: "unauthorized", requestId: "stub" });
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
  json(res, 404, { error: "not_found", requestId: "stub" });
}).listen(3001, () => console.log("stub BFF on 3001"));
