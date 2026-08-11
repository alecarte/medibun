import { describe, expect, it } from "vitest";

import { createFourDAdapter, UnknownTimeZoneError } from "./adapter-4d.js";
import { csvFile, csvRow, mdy, ymd, ymdhm } from "./test-fixtures.js";
import { SourceFileError } from "./types.js";

const TZ = "America/New_York";
const adapter = createFourDAdapter(TZ);

const PATIENT_HEADERS = ["patient_id", "first_name", "last_name", "dob", "phone", "email"];
const APPOINTMENT_HEADERS = [
  "appointment_id",
  "patient_id",
  "start_datetime",
  "status",
  "service_category",
  "provider",
];
const INQUIRY_HEADERS = [
  "inquiry_id",
  "patient_id",
  "inquiry_datetime",
  "channel",
  "outcome",
  "name",
  "phone",
];
const CONSULT_HEADERS = [
  "consult_id",
  "patient_id",
  "consult_datetime",
  "service_category",
  "outcome",
];

/** Synthetic patient row: obviously-fake identity, birth date assembled from parts. */
const patientRow = (id: string, birth: string) => [
  id,
  "Testerly",
  "Fakeman",
  birth,
  "555-0100",
  `${id}@example.invalid`,
];

describe("4D adapter — contract", () => {
  it("declares its source system and the entities it can produce", () => {
    expect(adapter.sourceSystem).toBe("4d");
    expect([...adapter.entities].sort()).toEqual([
      "appointments",
      "consults",
      "inquiries",
      "patients",
    ]);
  });

  it("refuses to build against an unknown practice timezone", () => {
    expect(() => createFourDAdapter("Mars/Olympus")).toThrow(UnknownTimeZoneError);
  });
});

describe("4D adapter — patients", () => {
  it("parses a roster, trimming values and nulling blanks", () => {
    const content = csvFile(PATIENT_HEADERS, [
      ["  p-1  ", " Testerly ", "Fakeman", ymd(1970, 4, 12), " 555-0100 ", ""],
      ["p-2", "", "", "", "", "second@example.invalid"],
    ]);

    const { rows, rejects } = adapter.parse("patients", content);

    expect(rejects).toEqual([]);
    expect(rows).toEqual([
      {
        sourceIdentity: "p-1",
        firstName: "Testerly",
        lastName: "Fakeman",
        dob: ymd(1970, 4, 12),
        phone: "555-0100",
        email: null,
      },
      {
        sourceIdentity: "p-2",
        firstName: null,
        lastName: null,
        dob: null,
        phone: null,
        email: "second@example.invalid",
      },
    ]);
  });

  it("accepts the US-style date the 4D export may carry", () => {
    const content = csvFile(PATIENT_HEADERS, [patientRow("p-1", mdy(1970, 4, 12))]);
    expect(adapter.parse("patients", content).rows[0]?.dob).toBe(ymd(1970, 4, 12));
  });

  it("rejects a row whose birth date is not a calendar date, keeping the good rows", () => {
    const content = csvFile(PATIENT_HEADERS, [
      patientRow("p-1", ymd(1970, 4, 12)),
      patientRow("p-2", "the-thirteenth"),
      patientRow("p-3", ymd(1970, 2, 30)),
    ]);

    const { rows, rejects } = adapter.parse("patients", content);

    expect(rows.map((r) => r.sourceIdentity)).toEqual(["p-1"]);
    expect(rejects.map((r) => r.line)).toEqual([3, 4]);
    for (const reject of rejects) {
      expect(reject.reason).toContain("dob");
    }
  });

  it("rejects a row with no source identity", () => {
    const content = csvFile(PATIENT_HEADERS, [patientRow("", ymd(1970, 4, 12))]);

    const { rows, rejects } = adapter.parse("patients", content);

    expect(rows).toEqual([]);
    expect(rejects).toHaveLength(1);
    expect(rejects[0]?.reason).toContain("patient_id");
  });

  it("rejects the second row carrying a source identity already seen in the file", () => {
    const content = csvFile(PATIENT_HEADERS, [
      patientRow("p-1", ymd(1970, 4, 12)),
      patientRow("p-1", ymd(1971, 5, 13)),
    ]);

    const { rows, rejects } = adapter.parse("patients", content);

    expect(rows).toHaveLength(1);
    expect(rejects).toHaveLength(1);
    expect(rejects[0]?.line).toBe(3);
    expect(rejects[0]?.reason).toContain("duplicate");
  });

  it("ignores columns it does not map and nulls the optional ones a file omits", () => {
    const content = csvFile(
      ["patient_id", "last_name", "loyalty_points"],
      [["p-1", "Fakeman", "9"]],
    );

    const { rows, rejects } = adapter.parse("patients", content);

    expect(rejects).toEqual([]);
    expect(rows[0]).toEqual({
      sourceIdentity: "p-1",
      firstName: null,
      lastName: "Fakeman",
      dob: null,
      phone: null,
      email: null,
    });
  });

  it("fails the whole file when a required column is missing", () => {
    const content = csvFile(["first_name", "last_name"], [["Testerly", "Fakeman"]]);

    expect(() => adapter.parse("patients", content)).toThrow(SourceFileError);
    expect(() => adapter.parse("patients", content)).toThrow(/patient_id/);
  });

  it("fails the whole file when there is no header row at all", () => {
    expect(() => adapter.parse("patients", "")).toThrow(SourceFileError);
  });
});

describe("4D adapter — appointments", () => {
  const appointmentRow = (id: string, at: string) => [
    id,
    "p-1",
    at,
    "Completed",
    " Injectables ",
    "Dr Fakeman",
  ];

  it("reads the practice-local wall time as the instant it names (summer and winter)", () => {
    const content = csvFile(APPOINTMENT_HEADERS, [
      appointmentRow("a-1", ymdhm(2026, 7, 15, 14, 30)),
      appointmentRow("a-2", ymdhm(2026, 1, 15, 9, 0)),
    ]);

    const { rows, rejects } = adapter.parse("appointments", content);

    expect(rejects).toEqual([]);
    // 2026-07-15 14:30 EDT (UTC-4) and 2026-01-15 09:00 EST (UTC-5).
    expect(rows[0]?.startAt.toISOString()).toBe("2026-07-15T18:30:00.000Z");
    expect(rows[1]?.startAt.toISOString()).toBe("2026-01-15T14:00:00.000Z");
    expect(rows[0]).toMatchObject({
      sourceIdentity: "a-1",
      patientSourceIdentity: "p-1",
      statusRaw: "Completed",
      serviceCategoryRaw: "Injectables",
      providerRaw: "Dr Fakeman",
    });
  });

  it("rejects an unparseable start time rather than falling back to UTC", () => {
    const content = csvFile(APPOINTMENT_HEADERS, [
      appointmentRow("a-1", "sometime tuesday"),
      appointmentRow("a-2", ymd(2026, 7, 15)),
    ]);

    const { rows, rejects } = adapter.parse("appointments", content);

    expect(rows).toEqual([]);
    expect(rejects.map((r) => r.line)).toEqual([2, 3]);
    for (const reject of rejects) {
      expect(reject.reason).toContain("start_datetime");
    }
  });

  it("rejects a row missing the staging-side patient join key", () => {
    const content = csvFile(APPOINTMENT_HEADERS, [
      ["a-1", "", ymdhm(2026, 7, 15, 14, 30), "Completed", "Injectables", "Dr Fakeman"],
    ]);

    const { rows, rejects } = adapter.parse("appointments", content);

    expect(rows).toEqual([]);
    expect(rejects[0]?.reason).toContain("patient_id");
  });
});

describe("4D adapter — inquiries and consults", () => {
  it("parses inquiries, allowing an inquirer who is not a patient", () => {
    const content = csvFile(INQUIRY_HEADERS, [
      ["i-1", "", ymdhm(2026, 7, 15, 10, 0), "Phone", "No booking", "Testerly F", "555-0101"],
    ]);

    const { rows, rejects } = adapter.parse("inquiries", content);

    expect(rejects).toEqual([]);
    expect(rows[0]).toEqual({
      sourceIdentity: "i-1",
      patientSourceIdentity: null,
      occurredAt: new Date("2026-07-15T14:00:00.000Z"),
      channelRaw: "Phone",
      outcomeRaw: "No booking",
      name: "Testerly F",
      phone: "555-0101",
    });
  });

  it("parses consults", () => {
    const content = csvFile(CONSULT_HEADERS, [
      ["c-1", "p-1", ymdhm(2026, 7, 15, 16, 45), "Surgical", "Not booked"],
    ]);

    const { rows, rejects } = adapter.parse("consults", content);

    expect(rejects).toEqual([]);
    expect(rows[0]).toEqual({
      sourceIdentity: "c-1",
      patientSourceIdentity: "p-1",
      consultAt: new Date("2026-07-15T20:45:00.000Z"),
      serviceCategoryRaw: "Surgical",
      outcomeRaw: "Not booked",
    });
  });
});

describe("4D adapter — RFC 4180 handling", () => {
  it("keeps quoted commas, embedded newlines, and escaped quotes intact", () => {
    const content = csvFile(APPOINTMENT_HEADERS, [
      [
        "a-1",
        "p-1",
        ymdhm(2026, 7, 15, 14, 30),
        "Completed, late",
        'Injectables\n"top up"',
        "Dr Fakeman",
      ],
    ]);

    const { rows, rejects } = adapter.parse("appointments", content);

    expect(rejects).toEqual([]);
    expect(rows[0]?.statusRaw).toBe("Completed, late");
    expect(rows[0]?.serviceCategoryRaw).toBe('Injectables\n"top up"');
  });

  it("counts lines across a record that spans several of them", () => {
    const content = csvFile(PATIENT_HEADERS, [
      ["p-1", "Testerly\nFakeman", "Fakeman", ymd(1970, 4, 12), "555-0100", ""],
      ["p-2", "Testerly", "Fakeman", "not-a-date", "555-0100", ""],
    ]);

    const { rejects } = adapter.parse("patients", content);

    // Record 1 occupies lines 2–3, so the bad record ends on line 4.
    expect(rejects.map((r) => r.line)).toEqual([4]);
  });

  it("fails the whole file on unclosed quoting, without echoing row content", () => {
    const content = `${csvRow(...PATIENT_HEADERS)}\np-1,"Testerly,Fakeman,,,\n`;

    expect(() => adapter.parse("patients", content)).toThrow(SourceFileError);
    try {
      adapter.parse("patients", content);
    } catch (err) {
      expect((err as Error).message).not.toContain("Testerly");
    }
  });
});

describe("4D adapter — PHI discipline", () => {
  it("never puts a field value in a reject reason (raw carries it, reasons do not)", () => {
    const badDate = "1970-13-45";
    const content = csvFile(PATIENT_HEADERS, [
      ["p-1", "Zzyzxine", "Quibbleworth", badDate, "555-0177", "leaky@example.invalid"],
    ]);

    const { rejects } = adapter.parse("patients", content);

    expect(rejects).toHaveLength(1);
    const [reject] = rejects;
    for (const value of [
      badDate,
      "Zzyzxine",
      "Quibbleworth",
      "555-0177",
      "leaky@example.invalid",
    ]) {
      expect(reject?.reason).not.toContain(value);
    }
    // The raw line is preserved verbatim — it is what the rejects FILE reports.
    expect(reject?.raw).toContain("Zzyzxine");
  });
});
