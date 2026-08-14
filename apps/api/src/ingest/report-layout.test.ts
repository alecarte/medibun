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

describe("report layout — classifying the report's furniture", () => {
  it("skips a reprinted title + header block without carrying the title as a section", () => {
    const content = reportFile(PREAMBLE, HEADERS, [
      sparseRow(WIDTH, { 0: "Dr Fakeman" }),
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

  it("carries a section row's provider down onto rows that leave the column blank", () => {
    const content = reportFile(PREAMBLE, HEADERS, [
      sparseRow(WIDTH, { 0: "Dr Fakeman" }),
      dataRow("09:00", "Testerly F"),
      sparseRow(WIDTH, { 0: "Provider: Dr Otherly" }),
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

  it("captures each Total row as the file's own reconciliation count", () => {
    const content = reportFile(PREAMBLE, HEADERS, [
      dataRow("09:00", "Testerly F"),
      sparseRow(WIDTH, { 0: "Total Appointments = 1,204" }),
      dataRow("10:00", "Otherly F"),
      sparseRow(WIDTH, { 3: "Total = 2" }),
    ]);

    const file = normalizeReport(content, SPEC);

    expect(file.rows).toHaveLength(2);
    expect(file.declaredTotals.map((t) => t.count)).toEqual([1204, 2]);
    expect(file.declaredTotals[0]?.label).toBe("Appointments");
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

  it("skips blank rows and counts every skipped row exactly once", () => {
    const content = reportFile(PREAMBLE, HEADERS, [
      sparseRow(WIDTH, {}),
      sparseRow(WIDTH, { 0: "Dr Fakeman" }),
      dataRow("09:00", "Testerly F"),
      sparseRow(WIDTH, { 0: "Total = 1" }),
    ]);

    const file = normalizeReport(content, SPEC);

    expect(file.rows).toHaveLength(1);
    expect(file.layoutRowCount).toBe(4 + 3);
  });

  it("reports each data row's line number and verbatim source line", () => {
    const content = reportFile(PREAMBLE, HEADERS, [
      sparseRow(WIDTH, { 0: "Dr Fakeman" }),
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
