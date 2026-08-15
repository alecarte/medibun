import { parse as parseCsv } from "csv-parse/sync";

import { SourceFileError, type DeclaredTotal } from "./types.js";

/**
 * The report-layout pre-pass (R0, RECOVERY_DESIGN.md review log 2026-08-14). The real
 * 4D exports are REPORT dumps, not clean tables: preamble rows (practice, report title,
 * filters, date range) before the real header row, a reprinted title + header block at
 * page breaks whose title text can differ from the report's own name, provider section
 * rows acting as group headers, day-separator rows above rows that carry only a time,
 * `Total X = N` rows, and values scattered across sparse spreadsheet columns.
 *
 * This module turns that into the flat, header-keyed rows the declarative column map in
 * `adapter-4d.ts` expects: it locates the real header row, classifies every other row as
 * data or furniture, carries group context (provider, day) DOWN onto the data rows, and
 * captures the file's own declared totals for reconciliation.
 *
 * Rows dropped as furniture are NOT rejects — a rejects file full of decoration helps
 * nobody — but they are COUNTED, so the operator sees what the pre-pass swallowed.
 *
 * Classification is STRUCTURAL, never by title text (R0: the reprinted title can differ
 * from the report's name, so matching on it would be a trap):
 *
 *   - blank row → furniture;
 *   - a row matching two or more of the entity's known column names → a reprinted
 *     header row (the same two-column bar the real header row is located by);
 *   - a row of at most two filled cells, one reading `Total … = N` → a declared total,
 *     furniture (a FULL row may legitimately be named "Total Body Lift: 1");
 *   - exactly ONE non-empty cell → resolved in this order, and the order is the rule:
 *     a calendar date is a DAY SEPARATOR (entities that carry a day); a row whose next
 *     non-blank neighbour is a reprinted header row is a page-break TITLE (adjacency is
 *     the only honest signal — the text is not); anything else is a SECTION row whose
 *     label becomes group context (entities that carry a section); failing all three, a
 *     cell sitting in a column the entity's map CONSUMES is a data row — the Patient
 *     Export prints a roster row with only its id filled — and a cell anywhere else is
 *     furniture;
 *   - a row whose PATIENT COLUMN is blank or holds a non-patient marker ("#",
 *     "Happening") → a non-patient calendar block (R0 (iv)), furniture; a marker in any
 *     other column is just a value, and the row stays;
 *   - everything else is a data row.
 *
 * Known limits, to be pinned at the first real local run: a page-break block whose
 * decoration spans MORE than one cell per row reads as a data row and lands in rejects
 * (visible immediately, a one-line fix); a title row that is NOT followed by a reprinted
 * header reads as a section row; and a page-break block that reprints SEVERAL lone rows
 * (practice name, then title) has only its last row read as the title — the rows above
 * it read as section rows, so a reprinted preamble line can ride down as group context
 * until the next real section row. R0's exports reprint a single title row, and the
 * alternative (swallowing the whole run) is worse: it drops a section row that happens to
 * sit against the page break, and every row after the break then inherits the PREVIOUS
 * section silently.
 */

/** One column the entity's map can consume, with the aliases it may be spelled as. */
export type ColumnSpec = {
  /** The name reject reasons and error messages use. */
  readonly canonical: string;
  /** Canonical name first, then aliases — first one present in the header row wins. */
  readonly names: readonly string[];
  /** Must be present in the located header row, or the file cannot be staged. */
  readonly required: boolean;
};

/** Which columns group context flows into, by canonical name. */
export type CarrySpec = {
  /** Filled from a section row when the data row leaves it blank (e.g. provider). */
  readonly section?: string;
  /** Completed from the day separator above when the cell holds only a time. */
  readonly day?: string;
  /** Names the patient; blank or "#" marks a non-patient calendar block. */
  readonly patient?: string;
};

export type LayoutSpec = {
  readonly columns: readonly ColumnSpec[];
  readonly carry?: CarrySpec;
};

export type NormalizedRow = {
  /** 1-based line the record ends on (a quoted record may span several). */
  readonly line: number;
  /** The verbatim source line — carry-down never touches it, so the rejects file
   *  still shows exactly what the export said. */
  readonly raw: string;
  /** The record with group context applied. */
  readonly record: readonly string[];
};

export type NormalizedFile = {
  /** The located header row, trimmed and lowercased. */
  readonly headers: readonly string[];
  /** Canonical column name → index in every record. */
  readonly columnAt: ReadonlyMap<string, number>;
  readonly rows: readonly NormalizedRow[];
  /** Rows recognized as report furniture and skipped (never rejects). */
  readonly layoutRowCount: number;
  readonly declaredTotals: readonly DeclaredTotal[];
};

/** csv-parse output with `info` + `raw`: the fields, the line number, and the verbatim
 *  source line. Records are read as ARRAYS (not keyed by header) because the header row
 *  is not the first row and because a ragged row must stay visible: keyed mode silently
 *  drops a long row's extra fields, which is how a misaligned export stages shifted
 *  values. */
type CsvItem = { record: string[]; raw: string; info: { lines: number } };

/** How far into the file the real header row may hide. The preamble is a handful of
 *  rows; scanning further would let a data row win the match on a short header. */
const HEADER_SCAN_ROWS = 50;

/** How many of the entity's columns a row must name to BE the header row — and the same
 *  bar a reprinted header row in the body is held to. */
const HEADER_MIN_COLUMNS = 2;

/** How a header cell is folded before anything is matched against it. Exported because
 *  the adapter's NEVER_MAPPED guard must fold the names it checks exactly the same way —
 *  a second spelling of this rule is a way for the guard to drift out of agreement with
 *  the matching it guards. */
export const normalizeHeader = (value: string): string => value.trim().toLowerCase();

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
/** A day separator: a bare date, optionally introduced by a weekday name. */
const DAY_SEPARATOR = /^(?:[a-z]+,?\s+)?(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{4})$/i;
/** A cell holding only a time — the appointment rows under a day separator. */
const TIME_ONLY = /^\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?$/i;
/** `Total X = N`, `Total: 1,204` — the file's own count of what it printed. */
const DECLARED_TOTAL = /^total\b(.*?)[=:]\s*([\d,]+)\s*$/i;
/** How many cells a total row may fill and still be furniture: the count, and at most a
 *  label beside it. Anything fuller is a data row that merely SAYS "total". */
const TOTAL_MAX_CELLS = 2;
/** A section row may label itself ("Provider: Dr Fakeman"); the label is not the group. */
const SECTION_LABEL = /^[^:]{0,20}:\s*/;
/** 4D's non-patient calendar blocks (R0 (iv)) — exact markers pinned at the first run. */
const NON_PATIENT_MARKERS = new Set(["#", "happening"]);

function readCsv(content: string): CsvItem[] {
  try {
    return parseCsv(content, {
      bom: true,
      info: true,
      raw: true,
      skipEmptyLines: true,
      // A ragged row must reach the adapter AS a row (rejected there, with its field
      // count), not abort the whole file.
      relaxColumnCount: true,
    }) as CsvItem[];
  } catch (err) {
    // The parser's own message can quote row content — its CODE is all that travels.
    const code = (err as { code?: string }).code ?? "CSV_PARSE_FAILED";
    throw new SourceFileError(`file is not readable as CSV (${code})`);
  }
}

/** How many of the entity's columns a row names — the header row scores highest. */
function headerScore(record: readonly string[], columns: readonly ColumnSpec[]): number {
  const names = new Set(record.map(normalizeHeader));
  return columns.filter((column) => column.names.some((name) => names.has(name))).length;
}

/** A calendar date rendered "YYYY-MM-DD", or undefined. Shape only: the adapter's own
 *  reader is what validates a data row's date. */
function separatorDate(value: string): string | undefined {
  const match = DAY_SEPARATOR.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const date = match[1]!;
  const us = US_DATE.exec(date);
  if (!us) {
    const iso = ISO_DATE.exec(date)!;
    return `${iso[1]}-${iso[2]!.padStart(2, "0")}-${iso[3]!.padStart(2, "0")}`;
  }
  return `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`;
}

/** Writes into a record that may be shorter than the column it is filling. */
function fill(record: string[], at: number, value: string): void {
  while (record.length <= at) {
    record.push("");
  }
  record[at] = value;
}

export function normalizeReport(content: string, spec: LayoutSpec): NormalizedFile {
  const items = readCsv(content);

  let headerAt = -1;
  let best = 0;
  items.slice(0, HEADER_SCAN_ROWS).forEach((item, at) => {
    const score = headerScore(item.record, spec.columns);
    if (score > best) {
      best = score;
      headerAt = at;
    }
  });
  // Two known columns, the same bar the body classifier holds a reprinted header to: a
  // preamble label/value row ("Patient", <a name>) names ONE, and accepting it would make
  // the error below quote a source VALUE. Nothing here is safe to name.
  if (best < HEADER_MIN_COLUMNS) {
    throw new SourceFileError(
      `no header row found in the first ${HEADER_SCAN_ROWS} rows of the file ` +
        `(a header row must name at least ${HEADER_MIN_COLUMNS} of the entity's columns)`,
    );
  }

  const headers = items[headerAt]!.record.map(normalizeHeader);
  const columnAt = new Map<string, number>();
  for (const column of spec.columns) {
    for (const name of column.names) {
      const at = headers.indexOf(name);
      if (at !== -1) {
        columnAt.set(column.canonical, at);
        break;
      }
    }
  }
  const missing = spec.columns
    .filter((column) => column.required && !columnAt.has(column.canonical))
    .map((column) => column.canonical);
  if (missing.length > 0) {
    // Column NAMES are safe to print (they are the report's own vocabulary, never a
    // patient value) and they are exactly what a header-spelling fix needs. Only cells
    // that ARE a known column name print: whatever else the accepted row holds — the
    // value beside a preamble label, an unmapped column's contents — never can.
    const known = new Set(spec.columns.flatMap((column) => column.names));
    throw new SourceFileError(
      `file is missing required columns: ${missing.join(", ")}; ` +
        `the header row found names: ${headers.filter((h) => known.has(h)).join(", ")}`,
    );
  }

  const carry = spec.carry ?? {};
  const body = items.slice(headerAt + 1);

  // Every body row's shape, decided before anything is carried: a lone cell can only be
  // told from a page-break title by what FOLLOWS it (R0: the title text itself lies).
  const kinds = body.map((item) => {
    const cells = item.record.map((cell) => cell.trim());
    const filled = cells.filter((cell) => cell !== "");
    if (filled.length === 0) {
      return "blank" as const;
    }
    if (headerScore(item.record, spec.columns) >= HEADER_MIN_COLUMNS) {
      return "header" as const;
    }
    // Furniture-SHAPED only: a total row is a count on an otherwise empty row. A revenue
    // line item may be CALLED "Total Body Lift: 1", and swallowing that populated row
    // would delete a real record invisibly (furniture is counted, never rejected).
    if (filled.length <= TOTAL_MAX_CELLS && cells.some((cell) => DECLARED_TOTAL.test(cell))) {
      return "total" as const;
    }
    return filled.length === 1 ? ("lone" as const) : ("data" as const);
  });

  /** The page-break TITLE: the lone row sitting against a reprinted header row. Only
   *  that row — an earlier lone row in the same run is a section row that happens to
   *  precede the page break, and swallowing it would carry the PREVIOUS section down
   *  onto every row after the break. */
  const isPageBreakTitle = (at: number): boolean => {
    let next = at + 1;
    while (next < kinds.length && kinds[next] === "blank") {
      next += 1;
    }
    return kinds[next] === "header";
  };

  /** Column indices the entity's map consumes: a lone cell in one of them is a data row
   *  with every optional column blank, not decoration. */
  const mappedColumns = new Set(columnAt.values());

  const rows: NormalizedRow[] = [];
  const declaredTotals: DeclaredTotal[] = [];
  let layoutRowCount = headerAt;
  let section: string | undefined;
  let day: string | undefined;

  body.forEach((item, at) => {
    const cells = item.record.map((cell) => cell.trim());
    const kind = kinds[at]!;

    if (kind === "blank" || kind === "header") {
      layoutRowCount += 1;
      return;
    }

    if (kind === "total") {
      const total = cells.map((cell) => DECLARED_TOTAL.exec(cell)).find((match) => match !== null)!;
      declaredTotals.push({
        label: total[1]!.trim(),
        count: Number(total[2]!.replaceAll(",", "")),
      });
      layoutRowCount += 1;
      return;
    }

    // A lone cell is furniture in three ways before it can be anything else — and only
    // then, if it sits in a column the map consumes, is it a one-cell DATA row that
    // falls through to the rest of this loop.
    if (kind === "lone") {
      const cellAt = cells.findIndex((cell) => cell !== "");
      const value = cells[cellAt]!;
      const date = carry.day === undefined ? undefined : separatorDate(value);
      if (date !== undefined) {
        day = date;
        layoutRowCount += 1;
        return;
      }
      if (isPageBreakTitle(at)) {
        layoutRowCount += 1;
        return;
      }
      if (carry.section !== undefined) {
        section = value.replace(SECTION_LABEL, "").trim();
        layoutRowCount += 1;
        return;
      }
      if (!mappedColumns.has(cellAt)) {
        layoutRowCount += 1;
        return;
      }
    }

    if (carry.patient !== undefined) {
      // A calendar block ("Happening", patient "#") is the schedule's own furniture, not
      // a patient the roster join could ever resolve — structure, never a reject (R0).
      // The PATIENT column alone decides: read anywhere else the markers would silently
      // delete a real row, and dropped rows are counted, never rejected.
      const patientAt = columnAt.get(carry.patient);
      const patient = patientAt === undefined ? "" : (cells[patientAt] ?? "");
      if (patient === "" || NON_PATIENT_MARKERS.has(patient.toLowerCase())) {
        layoutRowCount += 1;
        return;
      }
    }

    const record = [...item.record];
    const sectionAt = carry.section === undefined ? undefined : columnAt.get(carry.section);
    if (
      sectionAt !== undefined &&
      section !== undefined &&
      (record[sectionAt] ?? "").trim() === ""
    ) {
      fill(record, sectionAt, section);
    }
    const dayAt = carry.day === undefined ? undefined : columnAt.get(carry.day);
    if (dayAt !== undefined && day !== undefined && TIME_ONLY.test((record[dayAt] ?? "").trim())) {
      fill(record, dayAt, `${day} ${(record[dayAt] ?? "").trim()}`);
    }

    rows.push({ line: item.info.lines, raw: item.raw.replace(/\r?\n$/, ""), record });
  });

  return { headers, columnAt, rows, layoutRowCount, declaredTotals };
}
