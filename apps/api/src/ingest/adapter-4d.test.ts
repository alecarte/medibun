import { describe, expect, it } from "vitest";

import {
  createFourDAdapter,
  fourDColumnNames,
  NEVER_MAPPED,
  text,
  UnknownTimeZoneError,
} from "./adapter-4d.js";
import { csvRow, mdy, reportFile, sparseRow, ymd, ymdhm } from "./test-fixtures.js";
import { SourceFileError } from "./types.js";

/**
 * The 4D adapter against R0's REAL export shapes (RECOVERY_DESIGN.md review log,
 * 2026-08-14): report-layout dumps with preamble rows, section rows, day separators,
 * reprinted title/header blocks, `Total X = N` rows, and values scattered across sparse
 * spreadsheet columns. Every value here is synthetic (test-fixtures.ts).
 */

const TZ = "America/New_York";
const adapter = createFourDAdapter(TZ);

/** Patient Export (R0 (3)). Address columns are present in the export and never mapped. */
const PATIENT_HEADERS = [
  "First Name",
  "Last Name",
  "Id",
  "DOB",
  "Email",
  "Phone",
  "Phone Type",
  "Address 1",
  "City",
  "Spend",
];
const patientRow = (id: string, birth: string, spend = "1,250.00") => [
  "Testerly",
  "Fakeman",
  id,
  birth,
  `${id}@example.invalid`,
  "555-0100",
  "Mobile",
  "1 Nowhere Ln",
  "Faketown",
  spend,
];

/** Detailed Appointment List — All Calendars (R0 (9)), Allergy and Description included
 *  exactly as the export prints them — the adapter must never stage either. */
const APPOINTMENT_HEADERS = [
  "Date/Time",
  "Provider",
  "Patient",
  "DOB",
  "Age",
  "Phone",
  "Allergy",
  "Appt Type",
  "Description",
  "Created",
];
const APPOINTMENT_WIDTH = APPOINTMENT_HEADERS.length;
const appointmentRow = (
  when: string,
  patient: string,
  extra: Readonly<Record<number, string>> = {},
) =>
  sparseRow(APPOINTMENT_WIDTH, {
    0: when,
    2: patient,
    3: ymd(1970, 4, 12),
    5: "555-0100",
    7: "Injectables",
    ...extra,
  });

/** Conversion By Provider (R0): columns at A, D, G, I, N, O, R, T, W, Y — sparse by
 *  construction, which is exactly what the pre-pass has to survive. */
const CONSULT_WIDTH = 25;
const CONSULT_HEADERS = sparseRow(CONSULT_WIDTH, {
  0: "Consult Date",
  3: "Patient",
  6: "Quote Number",
  8: "Provider",
  13: "Coordinator",
  14: "Procedure",
  17: "Quote Amount",
  19: "Booked",
  22: "Completed",
  24: "Days To Book",
});
const consultRow = (quote: string, date: string, extra: Readonly<Record<number, string>> = {}) =>
  sparseRow(CONSULT_WIDTH, {
    0: date,
    3: "Testerly Fakeman",
    6: quote,
    13: "Coordinator Fakeman",
    14: "Surgical",
    17: "$7,500.00",
    19: "No",
    22: "Yes",
    24: "12",
    ...extra,
  });

/** Revenue by Staff Incl. Procedure Prepayments (R0 (8)). */
const TRANSACTION_HEADERS = [
  "DOS",
  "Paid Date",
  "Id",
  "Patient",
  "Description",
  "Category",
  "Report Tag",
  "Amount",
];
const transactionRow = (id: string, dos: string, amount: string, category = "Injectables") => [
  dos,
  mdy(2026, 8, 1),
  id,
  "Testerly Fakeman",
  "operator typed this",
  category,
  "INJ",
  amount,
];

const PREAMBLE = [
  ["Fakeman Plastic Surgery"],
  ["Detailed Appointment List — All Calendars"],
  ["Filters: All Calendars"],
  ["Range", mdy(2026, 7, 1), mdy(2026, 7, 31)],
];

describe("4D adapter — contract", () => {
  it("declares its source system and only the entities 4D actually exports", () => {
    expect(adapter.sourceSystem).toBe("4d");
    expect([...adapter.entities].sort()).toEqual([
      "appointments",
      "consults",
      "patients",
      "transactions",
    ]);
  });

  // R0: 4D tracks no inquiries — that pool is infeasible at Handal, so asking for them
  // fails loudly instead of quietly staging nothing.
  it("refuses an entity 4D does not export, naming it", () => {
    const content = reportFile([], PATIENT_HEADERS, [patientRow("p-1", ymd(1970, 4, 12))]);

    expect(() => adapter.parse("inquiries", content)).toThrow(SourceFileError);
    expect(() => adapter.parse("inquiries", content)).toThrow(/inquiries/);
  });

  it("refuses to build against an unknown practice timezone", () => {
    expect(() => createFourDAdapter("Mars/Olympus")).toThrow(UnknownTimeZoneError);
  });
});

describe("4D adapter — patients (Patient Export)", () => {
  it("reads the roster past the preamble, staging identity, contact, and spend", () => {
    const content = reportFile(PREAMBLE, PATIENT_HEADERS, [
      patientRow("p-1", ymd(1970, 4, 12)),
      patientRow("p-2", mdy(1971, 5, 13), "$89"),
      ["Total Patients = 2"],
    ]);

    const { rows, rejects, layoutRowCount, declaredTotals } = adapter.parse("patients", content);

    expect(rejects).toEqual([]);
    expect(rows[0]).toEqual({
      sourceIdentity: "p-1",
      firstName: "Testerly",
      lastName: "Fakeman",
      dob: ymd(1970, 4, 12),
      phone: "555-0100",
      phoneType: "Mobile",
      email: "p-1@example.invalid",
      spendCents: 125_000,
    });
    // US-style dates read the same as ISO ones.
    expect(rows[1]).toMatchObject({ dob: ymd(1971, 5, 13), spendCents: 8_900 });
    expect(layoutRowCount).toBe(PREAMBLE.length + 1);
    expect(declaredTotals).toEqual([{ label: "Patients", count: 2 }]);
  });

  // Data minimization (R0): the export ships address columns; nothing may stage them.
  it("never stages an address column the export happens to carry", () => {
    const content = reportFile([], PATIENT_HEADERS, [patientRow("p-1", ymd(1970, 4, 12))]);

    const { rows } = adapter.parse("patients", content);

    expect(JSON.stringify(rows)).not.toContain("Nowhere");
    expect(JSON.stringify(rows)).not.toContain("Faketown");
  });

  it("rejects a row whose birth date is not a calendar date, keeping the good rows", () => {
    const content = reportFile([], PATIENT_HEADERS, [
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

  it("rejects a row with no source identity and the second row repeating one", () => {
    const content = reportFile([], PATIENT_HEADERS, [
      patientRow("", ymd(1970, 4, 12)),
      patientRow("p-1", ymd(1970, 4, 12)),
      patientRow("p-1", ymd(1971, 5, 13)),
    ]);

    const { rows, rejects } = adapter.parse("patients", content);

    expect(rows.map((r) => r.sourceIdentity)).toEqual(["p-1"]);
    expect(rejects[0]?.reason).toContain("id");
    expect(rejects[1]?.reason).toContain("duplicate");
  });

  it("nulls the optional columns a file omits and ignores the ones it does not map", () => {
    const content = reportFile(
      [],
      ["Id", "Last Name", "Loyalty Points"],
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
      phoneType: null,
      email: null,
      spendCents: null,
    });
  });

  // A roster row can legitimately fill ONE cell: an id with every optional column blank.
  // Read as decoration it would vanish — neither staged nor rejected.
  it("stages a row that fills only its id column", () => {
    const content = reportFile(PREAMBLE, PATIENT_HEADERS, [
      patientRow("p-1", ymd(1970, 4, 12)),
      sparseRow(PATIENT_HEADERS.length, { 2: "p-2" }),
    ]);

    const { rows, rejects } = adapter.parse("patients", content);

    expect(rejects).toEqual([]);
    expect(rows[1]).toEqual({
      sourceIdentity: "p-2",
      firstName: null,
      lastName: null,
      dob: null,
      phone: null,
      phoneType: null,
      email: null,
      spendCents: null,
    });
  });

  // The header-spelling posture: R0 recorded what each column MEANS, not every exact
  // string, so a miss prints the header names it did find — a one-line map fix.
  it("fails the file when a required column is missing, naming the headers it found", () => {
    const content = reportFile(PREAMBLE, ["First Name", "Last Name", "Spend"], [["a", "b", "1"]]);

    expect(() => adapter.parse("patients", content)).toThrow(SourceFileError);
    try {
      adapter.parse("patients", content);
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("id");
      expect(message).toContain("first name");
      expect(message).toContain("spend");
      // Header NAMES only: no row value may appear.
      expect(message).not.toContain("Testerly");
    }
  });

  it("fails the file when no row carries the entity's columns at all", () => {
    expect(() => adapter.parse("patients", "")).toThrow(SourceFileError);
    expect(() => adapter.parse("patients", "alpha,beta\n1,2\n")).toThrow(SourceFileError);
  });
});

describe("4D adapter — appointments (Detailed Appointment List)", () => {
  it("carries provider sections and day separators down onto the rows beneath them", () => {
    const content = reportFile(PREAMBLE, APPOINTMENT_HEADERS, [
      ["Dr Fakeman"],
      [mdy(2026, 7, 15)],
      appointmentRow("9:00 AM", "Testerly F"),
      appointmentRow("2:30 PM", "Otherly F"),
      [mdy(2026, 7, 16)],
      appointmentRow("09:00", "Thirdly F"),
      ["Total Appointments = 3"],
    ]);

    const { rows, rejects, declaredTotals } = adapter.parse("appointments", content);

    expect(rejects).toEqual([]);
    expect(rows.map((r) => r.providerRaw)).toEqual(["Dr Fakeman", "Dr Fakeman", "Dr Fakeman"]);
    // 09:00 EDT (UTC-4) on the day the separator named, and the afternoon in 12-hour form.
    expect(rows.map((r) => r.startAt.toISOString())).toEqual([
      "2026-07-15T13:00:00.000Z",
      "2026-07-15T18:30:00.000Z",
      "2026-07-16T13:00:00.000Z",
    ]);
    expect(rows[0]).toMatchObject({
      patientSourceIdentity: null,
      statusRaw: null,
      patientName: "Testerly F",
      dob: ymd(1970, 4, 12),
      phone: "555-0100",
      serviceCategoryRaw: "Injectables",
    });
    expect(declaredTotals).toEqual([{ label: "Appointments", count: 3 }]);
  });

  it("reads a winter wall time in the practice's own zone", () => {
    const content = reportFile([], APPOINTMENT_HEADERS, [
      appointmentRow(ymdhm(2026, 1, 15, 9, 0), "Testerly F"),
    ]);

    expect(adapter.parse("appointments", content).rows[0]?.startAt.toISOString()).toBe(
      "2026-01-15T14:00:00.000Z",
    );
  });

  it("rejects an unparseable start time rather than falling back to UTC", () => {
    const content = reportFile([], APPOINTMENT_HEADERS, [
      appointmentRow("sometime tuesday", "Testerly F"),
      appointmentRow(ymd(2026, 7, 15), "Otherly F"),
    ]);

    const { rows, rejects } = adapter.parse("appointments", content);

    expect(rows).toEqual([]);
    for (const reject of rejects) {
      expect(reject.reason).toContain("date/time");
    }
  });

  // R0 (iv): the calendar carries blocks that are not patients at all.
  it("drops non-patient calendar blocks as layout, not as rejects", () => {
    const content = reportFile(PREAMBLE, APPOINTMENT_HEADERS, [
      ["Dr Fakeman"],
      [mdy(2026, 7, 15)],
      appointmentRow("09:00", "Testerly F"),
      appointmentRow("10:00", "Happening", { 7: "Staff meeting" }),
      appointmentRow("11:00", "#"),
      appointmentRow("12:00", ""),
    ]);

    const { rows, rejects, layoutRowCount } = adapter.parse("appointments", content);

    expect(rows.map((r) => r.patientName)).toEqual(["Testerly F"]);
    expect(rejects).toEqual([]);
    expect(layoutRowCount).toBe(PREAMBLE.length + 2 + 3);
  });

  // The two-store rule's live test (R0 (i)): Allergy is clinical, Description is
  // operator free text that can carry a visit reason. Neither may reach a staged row.
  it("never stages Allergy or Description, for any entity that ships them", () => {
    const secret = "SENTINEL-CLINICAL-TEXT";
    const appointments = reportFile([], APPOINTMENT_HEADERS, [
      appointmentRow("09:00 AM", "Testerly F", {
        0: ymdhm(2026, 7, 15, 9, 0),
        6: secret,
        8: secret,
      }),
    ]);
    const transactions = reportFile([], TRANSACTION_HEADERS, [
      [mdy(2026, 7, 15), "", "p-1", "Testerly F", secret, "Injectables", secret, "100.00"],
    ]);

    const staged = [
      adapter.parse("appointments", appointments).rows,
      adapter.parse("transactions", transactions).rows,
    ];

    for (const rows of staged) {
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(secret);
    }
    // The columns are named here so a future alias can never quietly claim one.
    expect(NEVER_MAPPED).toContain("allergy");
    expect(NEVER_MAPPED).toContain("description");
    expect(NEVER_MAPPED).toContain("report tag");
  });

  it("derives a stable identity from the row's identifying fields", () => {
    const content = reportFile([], APPOINTMENT_HEADERS, [
      appointmentRow(ymdhm(2026, 7, 15, 9, 0), "Testerly F", { 1: "Dr Fakeman" }),
    ]);

    const first = adapter.parse("appointments", content).rows[0]!.sourceIdentity;
    const second = adapter.parse("appointments", content).rows[0]!.sourceIdentity;

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  it("separates identical printed rows by occurrence, in file order", () => {
    const twice = appointmentRow(ymdhm(2026, 7, 15, 9, 0), "Testerly F", { 1: "Dr Fakeman" });
    const content = reportFile([], APPOINTMENT_HEADERS, [
      twice,
      twice,
      twice,
      appointmentRow(ymdhm(2026, 7, 15, 10, 0), "Testerly F", { 1: "Dr Fakeman" }),
    ]);

    const identities = adapter.parse("appointments", content).rows.map((r) => r.sourceIdentity);

    const [base] = identities;
    expect(identities.slice(0, 3)).toEqual([base, `${base}#2`, `${base}#3`]);
    expect(identities[3]).not.toBe(base);
    // Never a reject: two identical printed rows are two real appointments.
    expect(new Set(identities).size).toBe(4);
  });

  // Provider is INFERRED from a section row, so it moves with pagination: the same
  // appointment printed under a different page break carries a different provider and
  // would otherwise hash differently, re-importing as a duplicate row.
  it("derives one identity for the same appointment however the export paginated", () => {
    const when = ymdhm(2026, 7, 15, 9, 0);
    const layouts = [
      // Carried from a section row, from a DIFFERENT section row, printed in its own
      // column, and absent because the break left the row above the row that names it.
      reportFile([], APPOINTMENT_HEADERS, [["Dr Fakeman"], appointmentRow(when, "Testerly F")]),
      reportFile([], APPOINTMENT_HEADERS, [["Dr Otherly"], appointmentRow(when, "Testerly F")]),
      reportFile([], APPOINTMENT_HEADERS, [
        appointmentRow(when, "Testerly F", { 1: "Dr Fakeman" }),
      ]),
      reportFile([], APPOINTMENT_HEADERS, [appointmentRow(when, "Testerly F")]),
    ];

    const identities = layouts.map(
      (content) => adapter.parse("appointments", content).rows[0]!.sourceIdentity,
    );

    expect(new Set(identities).size).toBe(1);
  });

  // The accepted cost of excluding provider: two appointments identical in every printed
  // field but their provider now collide, and the occurrence suffix — the rule that
  // already separates true duplicates — is what keeps them apart.
  it("separates same-time rows under different providers by occurrence", () => {
    const content = reportFile([], APPOINTMENT_HEADERS, [
      appointmentRow(ymdhm(2026, 7, 15, 9, 0), "Testerly F", { 1: "Dr Fakeman" }),
      appointmentRow(ymdhm(2026, 7, 15, 9, 0), "Testerly F", { 1: "Dr Otherly" }),
    ]);

    const identities = adapter.parse("appointments", content).rows.map((r) => r.sourceIdentity);

    expect(identities[1]).toBe(`${identities[0]}#2`);
  });
});

/**
 * The two-store rule enforced BY CONSTRUCTION (R0 (i)): no map may claim an excluded
 * column, and one that tried could not even be built.
 */
describe("4D adapter — columns excluded by construction", () => {
  it("claims no NEVER_MAPPED column or alias, in any entity's map", () => {
    const columns = fourDColumnNames(TZ);

    // Every entity 4D exports is inspected — a new one cannot slip past this test.
    expect(Object.keys(columns).sort()).toEqual([...adapter.entities].sort());
    for (const [entity, names] of Object.entries(columns)) {
      const claimed = names.filter((name) => NEVER_MAPPED.includes(name));
      expect(claimed, entity).toEqual([]);
    }
  });

  it("cannot construct a field that claims an excluded column, as name or alias", () => {
    expect(() => text("appt type", false, ["description"])).toThrow(/description/);
    expect(() => text("allergy", false)).toThrow(/allergy/);
    // Spelling and spacing are normalized the same way header matching is.
    expect(() => text("Report Tag", false)).toThrow(/report tag/);
  });
});

describe("4D adapter — consults (Conversion By Provider)", () => {
  it("stages the sparse columns R0 recorded, by name and quote number", () => {
    const content = reportFile(
      [["Fakeman Plastic Surgery"], ["Conversion By Provider"]],
      CONSULT_HEADERS,
      [["Dr Fakeman"], consultRow("q-1", ymd(2026, 7, 15)), ["Total Quotes = 1"]],
    );

    const { rows, rejects, declaredTotals } = adapter.parse("consults", content);

    expect(rejects).toEqual([]);
    expect(rows[0]).toEqual({
      sourceIdentity: "q-1",
      patientSourceIdentity: null,
      patientName: "Testerly Fakeman",
      consultDate: ymd(2026, 7, 15),
      serviceCategoryRaw: "Surgical",
      outcomeRaw: null,
      providerRaw: "Dr Fakeman",
      quoteAmountCents: 750_000,
      bookedRaw: "No",
      completedRaw: "Yes",
    });
    expect(declaredTotals).toEqual([{ label: "Quotes", count: 1 }]);
  });

  it("stages neither the coordinator nor days-to-book", () => {
    const content = reportFile([], CONSULT_HEADERS, [consultRow("q-1", ymd(2026, 7, 15))]);

    expect(JSON.stringify(adapter.parse("consults", content).rows)).not.toContain("Coordinator");
  });

  it("rejects a consult row with no patient name — the only join key it has", () => {
    const content = reportFile([], CONSULT_HEADERS, [
      consultRow("q-1", ymd(2026, 7, 15), { 3: "" }),
    ]);

    const { rows, rejects } = adapter.parse("consults", content);

    expect(rows).toEqual([]);
    expect(rejects[0]?.reason).toContain("patient");
  });

  it("rejects a quote amount it cannot read rather than staging a zero", () => {
    const content = reportFile([], CONSULT_HEADERS, [
      consultRow("q-1", ymd(2026, 7, 15), { 17: "n/a" }),
    ]);

    const { rejects } = adapter.parse("consults", content);

    expect(rejects[0]?.reason).toContain("quote amount");
    expect(rejects[0]?.reason).not.toContain("n/a");
  });
});

describe("4D adapter — transactions (Revenue by Staff)", () => {
  it("prefers the date of service, reading dollars as integer cents", () => {
    const content = reportFile([], TRANSACTION_HEADERS, [
      transactionRow("p-1", mdy(2026, 7, 15), "$1,234.56"),
      transactionRow("", mdy(2026, 7, 16), "89", "Garments"),
      // A refund is a real row with negative money, never a missing one.
      transactionRow("p-1", mdy(2026, 7, 17), "-250.00"),
    ]);

    const { rows, rejects } = adapter.parse("transactions", content);

    expect(rejects).toEqual([]);
    expect(rows.map((r) => r.transactionDate)).toEqual([
      ymd(2026, 7, 15),
      ymd(2026, 7, 16),
      ymd(2026, 7, 17),
    ]);
    expect(rows.map((r) => r.amountCents)).toEqual([123_456, 8_900, -25_000]);
    // R0 win (a): this export DOES carry a patient Id, so dormancy joins by id.
    expect(rows[0]?.patientSourceIdentity).toBe("p-1");
    expect(rows[1]?.patientSourceIdentity).toBeNull();
  });

  it("falls back to the paid date when the export has no DOS column", () => {
    const content = reportFile(
      [],
      ["Paid Date", "Id", "Category", "Amount"],
      [[mdy(2026, 7, 15), "p-1", "Injectables", "100.00"]],
    );

    expect(adapter.parse("transactions", content).rows[0]?.transactionDate).toBe(ymd(2026, 7, 15));
  });

  it("rejects an unreadable amount rather than staging a zero", () => {
    const content = reportFile([], TRANSACTION_HEADERS, [
      transactionRow("p-1", mdy(2026, 7, 15), "n/a"),
    ]);

    const { rows, rejects } = adapter.parse("transactions", content);

    expect(rows).toEqual([]);
    expect(rejects[0]?.reason).toContain("amount");
    expect(rejects[0]?.reason).not.toContain("n/a");
  });

  it("separates a patient charged the same amount twice in a day by occurrence", () => {
    const twice = transactionRow("p-1", mdy(2026, 7, 15), "100.00");
    const content = reportFile([], TRANSACTION_HEADERS, [twice, twice]);

    const identities = adapter.parse("transactions", content).rows.map((r) => r.sourceIdentity);

    expect(identities[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(identities[1]).toBe(`${identities[0]}#2`);
  });
});

describe("4D adapter — CSV handling", () => {
  it("keeps quoted commas, embedded newlines, and escaped quotes intact", () => {
    const content = reportFile([], APPOINTMENT_HEADERS, [
      appointmentRow(ymdhm(2026, 7, 15, 14, 30), 'Testerly, "Junior"', {
        7: "Injectables\ntop up",
      }),
    ]);

    const { rows, rejects } = adapter.parse("appointments", content);

    expect(rejects).toEqual([]);
    expect(rows[0]?.patientName).toBe('Testerly, "Junior"');
    expect(rows[0]?.serviceCategoryRaw).toBe("Injectables\ntop up");
  });

  it("counts lines across a record that spans several of them", () => {
    const content = reportFile([], PATIENT_HEADERS, [
      patientRow("p-1", ymd(1970, 4, 12)).map((c, at) => (at === 0 ? "Testerly\nFakeman" : c)),
      patientRow("p-2", "not-a-date"),
    ]);

    const { rejects } = adapter.parse("patients", content);

    // Record 1 occupies lines 2–3, so the bad record ends on line 4.
    expect(rejects.map((r) => r.line)).toEqual([4]);
  });

  it("rejects a row carrying MORE fields than the header, which may have shifted", () => {
    const long = [...patientRow("p-2", ymd(1972, 6, 14)), "surplus"];
    const content = reportFile([], PATIENT_HEADERS, [patientRow("p-1", ymd(1970, 4, 12)), long]);

    const { rows, rejects } = adapter.parse("patients", content);

    expect(rows.map((r) => r.sourceIdentity)).toEqual(["p-1"]);
    expect(rejects[0]?.reason).toBe("row has 11 fields, header has 10");
    expect(rejects[0]?.reason).not.toContain("surplus");
  });

  it("reads a row the export truncated at its last filled cell", () => {
    const content = reportFile([], PATIENT_HEADERS, [
      ["Testerly", "Fakeman", "p-1", ymd(1970, 4, 12)],
    ]);

    const { rows, rejects } = adapter.parse("patients", content);

    expect(rejects).toEqual([]);
    expect(rows[0]).toMatchObject({ sourceIdentity: "p-1", phone: null, spendCents: null });
  });

  it("fails the whole file on unclosed quoting, without echoing row content", () => {
    const content = `${csvRow(...PATIENT_HEADERS)}\nTesterly,"Fakeman,p-1,,,\n`;

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
    const content = reportFile([], PATIENT_HEADERS, [
      [
        "Zzyzxine",
        "Quibbleworth",
        "p-1",
        badDate,
        "leaky@example.invalid",
        "555-0177",
        "Mobile",
        "1 Nowhere Ln",
        "Faketown",
        "10.00",
      ],
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
