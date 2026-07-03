import { describe, expect, it } from "vitest";

import { buildIcs, icsDataUrl } from "./ics";

describe("buildIcs", () => {
  const ics = buildIcs({
    id: "appt-1",
    title: "Botox — Aureva",
    description: "Botox with Riley Reyes",
    start: "2026-07-09T14:00:00.000Z",
    end: "2026-07-09T14:30:00.000Z",
    stamp: "2026-07-06T12:00:00.000Z",
  });

  it("emits a valid VEVENT with UTC basic-format dates", () => {
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("UID:appt-1@medibun");
    expect(ics).toContain("DTSTART:20260709T140000Z");
    expect(ics).toContain("DTEND:20260709T143000Z");
    expect(ics).toContain("DTSTAMP:20260706T120000Z");
    expect(ics).toContain("SUMMARY:Botox — Aureva");
    expect(ics).toContain("END:VCALENDAR");
  });

  it("uses CRLF line endings (RFC 5545)", () => {
    expect(ics.split("\r\n").length).toBeGreaterThan(5);
    expect(ics).not.toMatch(/[^\r]\n/);
  });

  it("escapes commas and semicolons in text fields", () => {
    const escaped = buildIcs({
      id: "a",
      title: "Botox, glabella; retouch",
      description: "d",
      start: "2026-07-09T14:00:00.000Z",
      end: "2026-07-09T14:30:00.000Z",
      stamp: "2026-07-06T12:00:00.000Z",
    });
    expect(escaped).toContain("SUMMARY:Botox\\, glabella\\; retouch");
  });
});

describe("icsDataUrl", () => {
  it("wraps the payload as a data: URL", () => {
    expect(icsDataUrl("BEGIN:VCALENDAR")).toBe(
      "data:text/calendar;charset=utf-8,BEGIN%3AVCALENDAR",
    );
  });
});
