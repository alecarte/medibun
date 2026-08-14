import { parse as parseCsv } from "csv-parse/sync";

import { zonedInstant } from "../staff.js";
import {
  SourceFileError,
  type ParseResult,
  type RejectedRow,
  type SourceAdapter,
  type StagedAppointmentRow,
  type StagedConsultRow,
  type StagedInquiryRow,
  type StagedPatientRow,
  type StagedRowByEntity,
  type StagedTransactionRow,
} from "./types.js";
import type { StagedEntity } from "../db/schema.js";

/**
 * Adapter #1: 4D CSV exports (RECOVERY_DESIGN.md §2). The whole source-specific
 * surface is the declarative column map below — when R0 records the practice's real
 * export layout, only that map changes.
 *
 * The header names here are PROVISIONAL, derived from §2's shopping list; headers are
 * matched case-insensitively after trimming, unmapped columns are ignored, and an
 * optional column the export omits stages as null. R0 has since recorded the real
 * exports — report-layout dumps needing a normalization pre-pass, with row identities
 * the adapter must DERIVE for the files that carry none — and that work lands in the
 * next PR; the maps below carry only R2a's schema fallout (nullable join keys, dates
 * where the export has no time, the transactions map).
 *
 * Two failure modes, deliberately different: a file the adapter cannot read at all
 * (missing required column, broken quoting) throws SourceFileError and stages nothing;
 * a single bad row becomes a reject carrying its line number and the COLUMN at fault —
 * never the value (PHI discipline, CLAUDE.md).
 */

/** The practice timezone the caller passed is not an IANA zone this runtime knows. */
export class UnknownTimeZoneError extends Error {
  constructor() {
    super("unknown practice timezone");
    this.name = "UnknownTimeZoneError";
  }
}

const pad = (n: number): string => String(n).padStart(2, "0");

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
/** "<date> <HH:mm>" or "<date>T<HH:mm>", with optional seconds (minute precision is
 *  what the schedule works in; a trailing :ss is read and dropped). */
const DATE_TIME = /^(.+?)[ T](\d{1,2}):(\d{2})(?::\d{2})?$/;

/** A real calendar date rendered as "YYYY-MM-DD", or undefined if it is neither. */
function calendarDate(value: string): string | undefined {
  const iso = ISO_DATE.exec(value);
  const us = iso ? null : US_DATE.exec(value);
  const parts = iso
    ? { year: iso[1]!, month: iso[2]!, day: iso[3]! }
    : us
      ? { year: us[3]!, month: us[1]!, day: us[2]! }
      : undefined;
  if (!parts) {
    return undefined;
  }
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const at = new Date(Date.UTC(year, month - 1, day));
  // Round-trip check: rejects month 13, February 30, and friends.
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    return undefined;
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Money written as dollars ("1234.56", "$1,234.56", "-250.00" for a refund) as integer
 *  cents, or undefined if it is not a money amount at all. A value we cannot read is a
 *  rejected row, never a zero: a silent zero understates the leak. */
function moneyCents(value: string): number | undefined {
  const match = /^(-?)\$?(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/.exec(value.replaceAll(" ", ""));
  if (!match) {
    return undefined;
  }
  const cents =
    Number(match[2]!.replaceAll(",", "")) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  return match[1] === "-" ? -cents : cents;
}

/** A practice-local wall time as the instant it names. The export carries no offset —
 *  reading it in any other zone silently moves appointments across days, so an
 *  unreadable value is a reject, never a UTC fallback. */
function practiceInstant(value: string, timeZone: string): Date | undefined {
  const match = DATE_TIME.exec(value);
  if (!match) {
    return undefined;
  }
  const date = calendarDate(match[1]!.trim());
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (!date || hour > 23 || minute > 59) {
    return undefined;
  }
  return zonedInstant(date, `${pad(hour)}:${pad(minute)}`, timeZone);
}

type Field<T> = {
  /** The source column, lowercase (headers are matched case-insensitively). */
  readonly column: string;
  /** The column must exist in the file AND carry a value in every row. */
  readonly required: boolean;
  /** What the operator should see in a reject reason, e.g. "a calendar date". */
  readonly expects: string;
  /** Undefined = unparseable → the row is rejected. Input is already trimmed. */
  readonly read: (value: string) => T | undefined;
};

/** One field spec per adapter-filled column of the staged row. */
type EntityMap<Row> = { readonly [K in keyof Row]-?: Field<NonNullable<Row[K]>> };

const text = (column: string, required: boolean): Field<string> => ({
  column,
  required,
  expects: "text",
  read: (value) => value,
});

const dateField = (column: string, required: boolean): Field<string> => ({
  column,
  required,
  expects: "a calendar date",
  read: calendarDate,
});

const centsField = (column: string, required: boolean): Field<number> => ({
  column,
  required,
  expects: "a dollar amount",
  read: moneyCents,
});

const instantField = (column: string, timeZone: string): Field<Date> => ({
  column,
  required: true,
  expects: "a practice-local date and time",
  read: (value) => practiceInstant(value, timeZone),
});

type EntityMaps = { readonly [K in StagedEntity]: EntityMap<StagedRowByEntity[K]> };

function columnMaps(timeZone: string): EntityMaps {
  const patients: EntityMap<StagedPatientRow> = {
    sourceIdentity: text("patient_id", true),
    firstName: text("first_name", false),
    lastName: text("last_name", false),
    dob: dateField("dob", false),
    phone: text("phone", false),
    email: text("email", false),
  };
  const appointments: EntityMap<StagedAppointmentRow> = {
    sourceIdentity: text("appointment_id", true),
    // R0: the real export carries neither a patient id nor a status — the roster join
    // runs on the name/DOB/phone below, so none of the four may be required.
    patientSourceIdentity: text("patient_id", false),
    patientName: text("patient_name", false),
    dob: dateField("dob", false),
    phone: text("phone", false),
    startAt: instantField("start_datetime", timeZone),
    statusRaw: text("status", false),
    serviceCategoryRaw: text("service_category", false),
    providerRaw: text("provider", false),
  };
  const inquiries: EntityMap<StagedInquiryRow> = {
    sourceIdentity: text("inquiry_id", true),
    // An inquirer may never have become a patient — nullable by design.
    patientSourceIdentity: text("patient_id", false),
    occurredAt: instantField("inquiry_datetime", timeZone),
    channelRaw: text("channel", false),
    outcomeRaw: text("outcome", false),
    name: text("name", false),
    phone: text("phone", false),
  };
  const consults: EntityMap<StagedConsultRow> = {
    sourceIdentity: text("consult_id", true),
    // R0: the Conversion By Provider export names the patient and nothing else — the
    // id stays null at import and the name-join runs at query time.
    patientSourceIdentity: text("patient_id", false),
    patientName: text("patient_name", true),
    consultDate: dateField("consult_date", true),
    serviceCategoryRaw: text("service_category", false),
    outcomeRaw: text("outcome", false),
    providerRaw: text("provider", false),
    quoteAmountCents: centsField("quote_amount", false),
    bookedRaw: text("booked", false),
    completedRaw: text("completed", false),
  };
  const transactions: EntityMap<StagedTransactionRow> = {
    sourceIdentity: text("transaction_id", true),
    patientSourceIdentity: text("patient_id", false),
    transactionDate: dateField("transaction_date", true),
    serviceCategoryRaw: text("category", false),
    amountCents: centsField("amount", true),
  };
  return { patients, appointments, inquiries, consults, transactions };
}

/** csv-parse output with `info` + `raw`: the fields, the line number, and the verbatim
 *  source line. Records are read as ARRAYS (not keyed by header) so a ragged row is
 *  visible: keyed mode silently drops a long row's extra fields and nulls a short row's
 *  missing ones, which is how a misaligned export stages shifted values. */
type CsvItem = { record: string[]; raw: string; info: { lines: number } };

/** Reads the file once and normalizes the header row (trimmed, lowercased); any parser
 *  failure becomes a file-level error carrying the parser's CODE only — its message can
 *  quote row content. */
function readCsv(content: string): { headers: string[]; items: CsvItem[] } {
  let items: CsvItem[];
  try {
    items = parseCsv(content, {
      bom: true,
      info: true,
      raw: true,
      skipEmptyLines: true,
      // A ragged row must reach us AS a row (rejected below, with its field count),
      // not abort the whole file.
      relaxColumnCount: true,
    }) as CsvItem[];
  } catch (err) {
    const code = (err as { code?: string }).code ?? "CSV_PARSE_FAILED";
    throw new SourceFileError(`file is not readable as CSV (${code})`);
  }
  const header = items.shift();
  if (!header) {
    throw new SourceFileError("file has no header row");
  }
  return { headers: header.record.map((h) => h.trim().toLowerCase()), items };
}

type RowResult<Row> = { ok: true; row: Row } | { ok: false; reason: string };

/** Applies one entity's column map to one record. Reasons name the COLUMN, never the
 *  value — the raw line is the rejects file's job. */
function buildRow<Row>(
  map: EntityMap<Row>,
  columnAt: ReadonlyMap<string, number>,
  record: readonly string[],
): RowResult<Row> {
  const row: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(map) as [string, Field<unknown>][]) {
    const at = columnAt.get(field.column);
    const value = (at === undefined ? "" : (record[at] ?? "")).trim();
    if (value === "") {
      if (field.required) {
        return { ok: false, reason: `${field.column} is required` };
      }
      row[key] = null;
      continue;
    }
    const parsed = field.read(value);
    if (parsed === undefined) {
      return { ok: false, reason: `${field.column} is not ${field.expects}` };
    }
    row[key] = parsed;
  }
  return { ok: true, row: row as Row };
}

export const FOUR_D_SOURCE_SYSTEM = "4d";

/**
 * The 4D adapter, bound to the practice timezone its export's wall times are written
 * in (the practice's own zone — the same value the clinical side carries on its
 * schedule actors; the CLI passes it explicitly rather than guessing).
 */
export function createFourDAdapter(timeZone: string): SourceAdapter {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
  } catch {
    throw new UnknownTimeZoneError();
  }
  const maps = columnMaps(timeZone);

  return {
    sourceSystem: FOUR_D_SOURCE_SYSTEM,
    entities: ["patients", "appointments", "inquiries", "consults", "transactions"],

    parse<E extends StagedEntity>(entity: E, content: string): ParseResult<E> {
      const map = maps[entity];
      const { headers, items } = readCsv(content);

      const missing = Object.values(map as Record<string, Field<unknown>>)
        .filter((field) => field.required && !headers.includes(field.column))
        .map((field) => field.column);
      if (missing.length > 0) {
        throw new SourceFileError(`file is missing required columns: ${missing.join(", ")}`);
      }

      // First occurrence wins if an export repeats a header name.
      const columnAt = new Map<string, number>();
      headers.forEach((name, at) => {
        if (!columnAt.has(name)) {
          columnAt.set(name, at);
        }
      });

      const rows: StagedRowByEntity[E][] = [];
      const rejects: RejectedRow[] = [];
      const seen = new Set<string>();
      for (const item of items) {
        const line = item.info.lines;
        const raw = item.raw.replace(/\r?\n$/, "");
        // A field count that disagrees with the header is a misalignment: every column
        // after the discrepancy may hold a neighbour's value. Counts are safe to name.
        if (item.record.length !== headers.length) {
          rejects.push({
            line,
            reason: `row has ${item.record.length} fields, header has ${headers.length}`,
            raw,
          });
          continue;
        }
        const result = buildRow(map, columnAt, item.record);
        if (!result.ok) {
          rejects.push({ line, reason: result.reason, raw });
          continue;
        }
        // The importer upserts the batch in one statement, so a source identity
        // repeated inside one file is a file-integrity problem, not a silent last-wins.
        const row = result.row as StagedRowByEntity[E] & { sourceIdentity: string };
        if (seen.has(row.sourceIdentity)) {
          rejects.push({ line, reason: "duplicate source identity in this file", raw });
          continue;
        }
        seen.add(row.sourceIdentity);
        rows.push(row);
      }
      return { rows, rejects };
    },
  };
}
