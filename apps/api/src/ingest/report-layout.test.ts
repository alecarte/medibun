import { describe, expect, it } from "vitest";

import { normalizeReport, type LayoutSpec } from "./report-layout.js";
import { csvRow, mdy, reportFile, sparseRow, ymd } from "./test-fixtures.js";
import { SourceFileError } from "./types.js";

/**
 * The report-layout pre-pass, tested on its own: what counts as a data row and what
 * counts as the report's furniture. Every fixture here is synthetic (test-fixtures.ts).
 */

const HEADERS = ["Date/Time", "Provider", "Patient", "DOB", "Appt Type"];
const WIDTH = HEADERS.length;

const column = (canonical: string, required = false, aliases: readonly string[] = []) => ({
  canonical,
  names: [canonical, ...aliases],
  required,
});

const SPEC: LayoutSpec = {
  columns: [
    column("date/time", true, ["date"]),
    column("provider"),
    column("patient", true),
    column("dob"),
    column("appt type"),
  ],
  carry: { section: "provider", day: "date/time", patient: "patient" },
};

/** Synthetic values a header-location failure must never print. */
const PATIENT_VALUE = "Zzyzxine Quibbleworth";
const PROVIDER_VALUE = "Dr Nowhereman";

/** The preamble every 4D export opens with: practice, report title, filters, range. */
const PREAMBLE = [
  sparseRow(WIDTH, { 0: "Fakeman Plastic Surgery" }),
  sparseRow(WIDTH, { 0: "Detailed Appointment List — All Calendars" }),
  sparseRow(WIDTH, { 0: "Filters: All Calendars" }),
  sparseRow(WIDTH, { 0: "Range", 1: mdy(2026, 7, 1), 2: mdy(2026, 7, 31) }),
];

const dataRow = (time: string, patient: string, provider = "", type = "Injectables") =>
  sparseRow(WIDTH, { 0: time, 1: provider, 2: patient, 4: type });

const cellsOf = (record: readonly string[], columnAt: ReadonlyMap<string, number>) => ({
  when: record[columnAt.get("date/time")!],
  provider: record[columnAt.get("provider")!],
  patient: record[columnAt.get("patient")!],
});

describe("report layout — locating the real header row", () => {
  it("skips the preamble and reads the row where the entity's columns appear", () => {
    const content = reportFile(PREAMBLE, HEADERS, [dataRow("09:00", "Testerly F", "Dr Fakeman")]);

    const file = normalizeReport(content, SPEC);

    expect(file.headers).toEqual(["date/time", "provider", "patient", "dob", "appt type"]);
    expect(file.columnAt.get("patient")).toBe(2);
    expect(file.rows).toHaveLength(1);
    // The four preamble rows are layout, not rejects.
    expect(file.layoutRowCount).toBe(4);
  });

  it("resolves a column through its aliases, canonical name first", () => {
    const content = reportFile(
      [],
      ["Date", "Provider", "Patient"],
      [["09:00", "Dr F", "Testerly"]],
    );

    const file = normalizeReport(content, SPEC);

    expect(file.columnAt.get("date/time")).toBe(0);
  });

  it("names the header row it found when a required column is not in it", () => {
    const content = reportFile(PREAMBLE, ["Provider", "DOB", "Appt Type"], [["Dr F", "", ""]]);

    expect(() => normalizeReport(content, SPEC)).toThrow(SourceFileError);
    try {
      normalizeReport(content, SPEC);
    } catch (err) {
      const message = (err as Error).message;
      // Column NAMES are safe to print; the first real run pins the spelling from this.
      expect(message).toContain("date/time");
      expect(message).toContain("patient");
      expect(message).toContain("appt type");
    }
  });

  it("refuses a file whose rows carry none of the entity's columns", () => {
    const content = reportFile([], ["alpha", "beta"], [["1", "2"]]);

    expect(() => normalizeReport(content, SPEC)).toThrow(SourceFileError);
  });

  // A preamble label/value row names ONE column and carries a patient value beside it.
  // One column is not a header row: accepting it would make that value the error's text.
  it("refuses a candidate row that names only one of the entity's columns", () => {
    const content = reportFile(
      [["Patient", PATIENT_VALUE]],
      // The real header row, misspelled past recognition — the case that lets a
      // preamble row win the scan at all.
      ["Date/Tyme", "Providr", "Patinet", "D.O.B.", "Appt Typ"],
      [["09:00", "Dr Fakeman", PATIENT_VALUE, "", "Injectables"]],
    );

    expect(() => normalizeReport(content, SPEC)).toThrow(SourceFileError);
    try {
      normalizeReport(content, SPEC);
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("no header row found");
      expect(message.toLowerCase()).not.toContain(PATIENT_VALUE.toLowerCase());
    }
  });

  // The same preamble row with a second label ties the misspelled header row on score,
  // and ties go to the earliest row — so it wins, and its VALUES must not print.
  it("prints only recognized column names from the row it accepted", () => {
    const content = reportFile(
      [["Patient", PATIENT_VALUE, "Provider", PROVIDER_VALUE]],
      ["Date/Tyme", "Providr", "Patinet", "D.O.B.", "Appt Typ"],
      [["09:00", PROVIDER_VALUE, PATIENT_VALUE, "", "Injectables"]],
    );

    expect(() => normalizeReport(content, SPEC)).toThrow(SourceFileError);
    try {
      normalizeReport(content, SPEC);
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("date/time");
      expect(message).toContain("patient");
      for (const value of [PATIENT_VALUE, PROVIDER_VALUE]) {
        expect(message.toLowerCase()).not.toContain(value.toLowerCase());
      }
    }
  });

  it("fails on unreadable CSV with the parser code only", () => {
    const content = `${csvRow(...HEADERS)}\n"unclosed,,,,\n`;

    expect(() => normalizeReport(content, SPEC)).toThrow(SourceFileError);
    try {
      normalizeReport(content, SPEC);
    } catch (err) {
      expect((err as Error).message).not.toContain("unclosed");
    }
  });
});

/** A section row as R0's exports print one: a lone cell in COLUMN 0 — which this entity
 *  maps (its date column), not the provider column the context flows into. */
const sectionRow = (value: string) => sparseRow(WIDTH, { 0: value });

describe("report layout — classifying the report's furniture", () => {
  it("skips a reprinted title + header block without carrying the title as a section", () => {
    const content = reportFile(PREAMBLE, HEADERS, [
      sectionRow("Dr Fakeman"),
      dataRow("09:00", "Testerly F"),
      // The page break reprints a title — which R0 warns can differ from the report's
      // own name — immediately above a reprinted header row.
      sparseRow(WIDTH, { 0: "Quote Acceptance Detail" }),
      HEADERS,
      dataRow("10:00", "Otherly F"),
    ]);

    const file = normalizeReport(content, SPEC);

    expect(file.rows).toHaveLength(2);
    // Both rows inherit the SECTION row's provider — never the reprinted title.
    expect(file.rows.map((r) => cellsOf(r.record, file.columnAt).provider)).toEqual([
      "Dr Fakeman",
      "Dr Fakeman",
    ]);
  });

  // Only the lone row ADJACENT to the reprinted header is the title. Swallowing the whole
  // run would drop the section row that happens to sit against the page break, and every
  // row after the break would silently inherit the PREVIOUS section's provider.
  it("keeps a section row that sits immediately before a page-break block", () => {
    const content = reportFile(PREAMBLE, HEADERS, [
      sectionRow("Dr Fakeman"),
      dataRow("09:00", "Testerly F"),
      sectionRow("Dr Otherly"),
      sparseRow(WIDTH, { 0: "Detailed Appointment List" }),
      HEADERS,
      dataRow("10:00", "Otherly F"),
    ]);

    const file = normalizeReport(content, SPEC);

    expect(file.rows.map((r) => cellsOf(r.record, file.columnAt).provider)).toEqual([
      "Dr Fakeman",
      "Dr Otherly",
    ]);
    // Two section rows, the title, and the reprinted header — furniture, all counted.
    expect(file.layoutRowCount).toBe(4 + 4);
  });

  it("carries a section row's provider down onto rows that leave the column blank", () => {
    const content = reportFile(PREAMBLE, HEADERS, [
      sectionRow("Dr Fakeman"),
      dataRow("09:00", "Testerly F"),
      sectionRow("Provider: Dr Otherly"),
      dataRow("10:00", "Otherly F"),
      // A row that names its own provider keeps it — carry-down fills blanks only.
      dataRow("11:00", "Thirdly F", "Dr Thirdly"),
    ]);

    const file = normalizeReport(content, SPEC);

    expect(file.rows.map((r) => cellsOf(r.record, file.columnAt).provider)).toEqual([
      "Dr Fakeman",
      "Dr Otherly",
      "Dr Thirdly",
    ]);
  });

  // The one carve-out from "any lone cell is the section": read as a section, "11:00"
  // loses its digits to the section label and becomes a provider called "00" that then
  // rides down onto every row beneath it. It falls through as a data row instead.
  it("never reads a lone TIME as the section", () => {
    const content = reportFile(PREAMBLE, HEADERS, [
      sectionRow("Dr Fakeman"),
      dataRow("09:00", "Testerly F"),
      sparseRow(WIDTH, { 0: "11:00" }),
      dataRow("12:00", "Otherly F"),
    ]);

    const file = normalizeReport(content, SPEC);

    expect(file.rows.map((r) => cellsOf(r.record, file.columnAt).provider)).toEqual([
      "Dr Fakeman",
      "Dr Fakeman",
    ]);
  });

  it("completes a time-only row from the day separator above it", () => {
    const content = reportFile(PREAMBLE, HEADERS, [
      sparseRow(WIDTH, { 0: mdy(2026, 7, 15) }),
      dataRow("9:00 AM", "Testerly F"),
      sparseRow(WIDTH, { 0: ymd(2026, 7, 16) }),
      dataRow("10:30", "Otherly F"),
      // A row carrying its own full date is left alone.
      dataRow(`${ymd(2026, 7, 17)} 08:15`, "Thirdly F"),
    ]);

    const file = normalizeReport(content, SPEC);

    expect(file.rows.map((r) => cellsOf(r.record, file.columnAt).when)).toEqual([
      `${ymd(2026, 7, 15)} 9:00 AM`,
      `${ymd(2026, 7, 16)} 10:30`,
      `${ymd(2026, 7, 17)} 08:15`,
    ]);
  });

  // A separator is validated against a real calendar, not against a date-shaped regex:
  // February 30th is not a day, so it cannot become the day every row beneath it belongs
  // to. It falls through the lone-cell rules instead (here: read as a section row, which
  // changes no row's DAY — the point of this test).
  it("never carries a date-shaped cell that is not a real date as the day", () => {
    const content = reportFile(PREAMBLE, HEADERS, [
      sparseRow(WIDTH, { 0: ymd(2026, 7, 15) }),
      dataRow("09:00", "Testerly F"),
      sparseRow(WIDTH, { 0: ymd(2026, 2, 30) }),
      dataRow("10:30", "Otherly F"),
    ]);

    const file = normalizeReport(content, SPEC);

    expect(file.rows.map((r) => cellsOf(r.record, file.columnAt).when)).toEqual([
      `${ymd(2026, 7, 15)} 09:00`,
      `${ymd(2026, 7, 15)} 10:30`,
    ]);
  });

  it("captures each Total row as the file's own reconciliation count", () => {
    const content = reportFile(PREAMBLE, HEADERS, [
      dataRow("09:00", "Testerly F"),
      sparseRow(WIDTH, { 0: "Total Appointments = 1,204" }),
      dataRow("10:00", "Otherly F"),
      sparseRow(WIDTH, { 3: "Total = 2" }),
    ]);

    const file = normalizeReport(content, SPEC);

    expect(file.rows).toHaveLength(2);
    expect(file.declaredTotals).toEqual([1204, 2]);
  });

  // A revenue line item can be CALLED "Total Body Lift" — furniture is a shape (a lone
  // count on an otherwise empty row), never a phrase, or a real row vanishes uncounted.
  it("keeps a populated row whose text merely reads like a total", () => {
    const content = reportFile(PREAMBLE, HEADERS, [
      dataRow("09:00", "Testerly F", "Dr Fakeman", "Total Body Lift: 1"),
      sparseRow(WIDTH, { 0: "Total Appointments = 1" }),
    ]);

    const file = normalizeReport(content, SPEC);

    expect(file.rows).toHaveLength(1);
    expect(cellsOf(file.rows[0]!.record, file.columnAt).patient).toBe("Testerly F");
    // Only the furniture row declares a total; the data row contributes none.
    expect(file.declaredTotals).toEqual([1]);
  });

  it("drops non-patient calendar blocks as structure rather than rejecting them", () => {
    const content = reportFile(PREAMBLE, HEADERS, [
      dataRow("09:00", "Testerly F"),
      dataRow("10:00", "#"),
      sparseRow(WIDTH, { 0: "11:00", 2: "Happening", 4: "Staff meeting" }),
      sparseRow(WIDTH, { 0: "12:00", 4: "Lunch" }),
    ]);

    const file = normalizeReport(content, SPEC);

    expect(file.rows).toHaveLength(1);
    expect(file.layoutRowCount).toBe(4 + 3);
  });

  // The markers mean "this block names no patient" — read anywhere else they silently
  // delete a real appointment, so only the PATIENT column is consulted.
  it("reads the non-patient markers in the patient column only", () => {
    const content = reportFile(PREAMBLE, HEADERS, [
      sparseRow(WIDTH, { 0: "09:00", 2: "Testerly F", 4: "#" }),
      dataRow("10:00", ""),
    ]);

    const file = normalizeReport(content, SPEC);

    expect(file.rows.map((r) => cellsOf(r.record, file.columnAt).patient)).toEqual(["Testerly F"]);
    // Only the blank-patient row is furniture.
    expect(file.layoutRowCount).toBe(4 + 1);
  });

  it("skips blank rows and counts every skipped row exactly once", () => {
    const content = reportFile(PREAMBLE, HEADERS, [
      sparseRow(WIDTH, {}),
      sectionRow("Dr Fakeman"),
      dataRow("09:00", "Testerly F"),
      sparseRow(WIDTH, { 0: "Total = 1" }),
    ]);

    const file = normalizeReport(content, SPEC);

    expect(file.rows).toHaveLength(1);
    expect(file.layoutRowCount).toBe(4 + 3);
  });

  it("reports each data row's line number and verbatim source line", () => {
    const content = reportFile(PREAMBLE, HEADERS, [
      sectionRow("Dr Fakeman"),
      dataRow("09:00", "Testerly F"),
    ]);

    const file = normalizeReport(content, SPEC);

    // 4 preamble + header + section = 6 lines before it.
    expect(file.rows[0]?.line).toBe(7);
    expect(file.rows[0]?.raw).toContain("Testerly F");
    // Carry-down changes the record, never the raw line the rejects file would show.
    expect(file.rows[0]?.raw).not.toContain("Dr Fakeman");
  });
});

/**
 * The Patient Export's shape: no group context to carry, and a row can legitimately fill
 * ONE cell — an id with every optional column blank. A lone cell is only furniture when
 * it sits outside the columns the entity's map consumes.
 */
describe("report layout — a lone cell in a column the entity maps", () => {
  const ROSTER_HEADERS = ["Id", "First Name", "Last Name", "Loyalty Points"];
  const ROSTER_WIDTH = ROSTER_HEADERS.length;
  const ROSTER_SPEC: LayoutSpec = {
    columns: [column("id", true), column("first name"), column("last name")],
  };

  it("stages a row filled only in a mapped column, and skips one outside them", () => {
    const content = reportFile([["Fakeman Plastic Surgery"]], ROSTER_HEADERS, [
      sparseRow(ROSTER_WIDTH, { 0: "p-1", 1: "Testerly", 2: "Fakeman" }),
      // Every optional column blank: a real roster row, not decoration.
      sparseRow(ROSTER_WIDTH, { 0: "p-2" }),
      // The same shape in an UNMAPPED column is the report's own furniture.
      sparseRow(ROSTER_WIDTH, { 3: "Loyalty tier: gold" }),
    ]);

    const file = normalizeReport(content, ROSTER_SPEC);

    expect(file.rows.map((r) => r.record[0])).toEqual(["p-1", "p-2"]);
    expect(file.layoutRowCount).toBe(1 + 1);
  });

  it("still reads a page-break title in a mapped column as furniture", () => {
    const content = reportFile([], ROSTER_HEADERS, [
      sparseRow(ROSTER_WIDTH, { 0: "p-1", 1: "Testerly", 2: "Fakeman" }),
      // The reprinted title lands in column 0 — which this entity maps. Adjacency to the
      // reprinted header row is what tells it from an id-only row.
      sparseRow(ROSTER_WIDTH, { 0: "Quote Acceptance Detail" }),
      ROSTER_HEADERS,
      sparseRow(ROSTER_WIDTH, { 0: "p-2" }),
    ]);

    const file = normalizeReport(content, ROSTER_SPEC);

    expect(file.rows.map((r) => r.record[0])).toEqual(["p-1", "p-2"]);
    expect(file.layoutRowCount).toBe(2);
  });
});

/**
 * The Conversion By Provider shape: a section to carry, no calendar blocks, and a patient
 * column that is the report's only join key. Its section rows land in COLUMN 0 — a column
 * the map consumes — so an entity that carries a section reads a lone cell as the section
 * wherever it sits. The residual ambiguity is the deliberate cost, pinned below.
 */
describe("report layout — a lone cell in a section-carrying entity", () => {
  const CONSULT_HEADERS = ["Consult Date", "Patient", "Provider"];
  const CONSULT_SPEC: LayoutSpec = {
    columns: [column("consult date", true), column("patient", true), column("provider")],
    carry: { section: "provider" },
  };

  it("reads a section row printed in a MAPPED column and carries it down", () => {
    const content = reportFile([], CONSULT_HEADERS, [
      sparseRow(3, { 0: "Dr Fakeman" }),
      [ymd(2026, 7, 15), "Testerly F", ""],
      [ymd(2026, 7, 16), "Thirdly F", ""],
    ]);

    const file = normalizeReport(content, CONSULT_SPEC);

    expect(file.rows.map((r) => r.record[1])).toEqual(["Testerly F", "Thirdly F"]);
    expect(file.rows.map((r) => r.record[2])).toEqual(["Dr Fakeman", "Dr Fakeman"]);
  });

  // KNOWN LIMIT, deliberately taken: a row that legitimately fills one cell — a patient
  // name with every other column blank — reads as a section here. The alternative
  // (deciding by column) broke the systematic case, because R0's section rows sit in a
  // column the map consumes; a degenerate one-cell data row would reject anyway. Whether
  // these exports print such a row at all is a first-run observation.
  it("reads a lone patient name as a section too — the residual ambiguity", () => {
    const content = reportFile([], CONSULT_HEADERS, [
      sparseRow(3, { 0: "Dr Fakeman" }),
      [ymd(2026, 7, 15), "Testerly F", ""],
      sparseRow(3, { 1: "Otherly F" }),
      [ymd(2026, 7, 16), "Thirdly F", ""],
    ]);

    const file = normalizeReport(content, CONSULT_SPEC);

    expect(file.rows.map((r) => r.record[1])).toEqual(["Testerly F", "Thirdly F"]);
    expect(file.rows.map((r) => r.record[2])).toEqual(["Dr Fakeman", "Otherly F"]);
  });
});

describe("report layout — a file with no furniture at all", () => {
  it("reads a plain table whose first row is already the header", () => {
    const content = reportFile([], HEADERS, [
      dataRow("09:00", "Testerly F", "Dr Fakeman"),
      dataRow("10:00", "Otherly F", "Dr Fakeman"),
    ]);

    const file = normalizeReport(content, SPEC);

    expect(file.rows).toHaveLength(2);
    expect(file.layoutRowCount).toBe(0);
    expect(file.declaredTotals).toEqual([]);
  });
});
