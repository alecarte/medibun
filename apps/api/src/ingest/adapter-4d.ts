import { createHash } from "node:crypto";

import { calendarDate, isKnownTimeZone, pad } from "./dates.js";
import {
  normalizeHeader,
  normalizeReport,
  type CarrySpec,
  type ColumnSpec,
} from "./report-layout.js";
import { zonedInstant } from "../staff.js";
import {
  SourceFileError,
  type ParseResult,
  type RejectedRow,
  type SourceAdapter,
  type StagedAppointmentRow,
  type StagedConsultRow,
  type StagedPatientRow,
  type StagedRowByEntity,
  type StagedTransactionRow,
} from "./types.js";
import type { StagedEntity } from "../db/schema.js";

/**
 * Adapter #1: 4D CSV exports (RECOVERY_DESIGN.md §2). Two source-specific surfaces and
 * nothing else: the report-layout pre-pass (`report-layout.ts`, which turns 4D's report
 * dumps into flat rows) and the declarative column map below.
 *
 * The maps carry R0's REAL exports (review log, 2026-08-14) — Patient Export, Detailed
 * Appointment List — All Calendars, Conversion By Provider, and Revenue by Staff Incl.
 * Procedure Prepayments. What R0 recorded is each column's MEANING, not every exact
 * header string, so matching is deliberately tolerant: headers are trimmed and
 * lowercased, each field lists the aliases the export may spell it as (canonical name
 * first, first match wins), unmapped columns are ignored, and an optional column the
 * export omits stages as null. When a required column cannot be found the file fails
 * with a SourceFileError that PRINTS THE HEADER NAMES it did find — column names are
 * report vocabulary, never patient values — so the first real local run pins any
 * mismatch as a one-line map fix rather than an investigation.
 *
 * Two columns are excluded BY CONSTRUCTION rather than mapped: the appointment export's
 * `Allergy` (clinical) and `Description` (operator free text that can carry a visit
 * reason), plus the revenue export's line-item description and Report Tag. No field
 * below names them, no staging column exists for them, and `NEVER_MAPPED` pins that —
 * this is the two-store rule's live test (R0 (i), DATA_MODEL.md).
 *
 * `inquiries` is not in this adapter's entity list at all: 4D tracks no inquiries
 * (R0 — the pool is infeasible at Handal), and asking for them fails loudly.
 *
 * Two failure modes, deliberately different: a file the adapter cannot read at all
 * (no locatable header, missing required column, broken quoting) throws SourceFileError
 * and stages nothing; a single bad row becomes a reject carrying its line number and the
 * COLUMN at fault — never the value (PHI discipline, CLAUDE.md). Report furniture is
 * neither: it is skipped and counted (`layoutRowCount`).
 */

/** The practice timezone the caller passed is not an IANA zone this runtime knows. */
export class UnknownTimeZoneError extends Error {
  constructor() {
    super("unknown practice timezone");
    this.name = "UnknownTimeZoneError";
  }
}

/** "<date> <HH:mm>" or "<date>T<HH:mm>", with optional seconds and an optional AM/PM
 *  (minute precision is what the schedule works in; a trailing :ss is read and dropped). */
const DATE_TIME = /^(.+?)[ T](\d{1,2}):(\d{2})(?::\d{2})?\s*(?:([ap])\.?m\.?)?$/i;

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

/** A practice-local wall time as the instant it names, in 24-hour or AM/PM spelling
 *  (the appointment export prints a clock, and which one is a first-run detail). The
 *  export carries no offset — reading it in any other zone silently moves appointments
 *  across days, so an unreadable value is a reject, never a UTC fallback. */
function practiceInstant(value: string, timeZone: string): Date | undefined {
  const match = DATE_TIME.exec(value);
  if (!match) {
    return undefined;
  }
  const date = calendarDate(match[1]!.trim());
  const meridiem = match[4]?.toLowerCase();
  let hour = Number(match[2]);
  const minute = Number(match[3]);
  if (!date || minute > 59 || (meridiem ? hour < 1 || hour > 12 : hour > 23)) {
    return undefined;
  }
  if (meridiem === "p" && hour < 12) {
    hour += 12;
  } else if (meridiem === "a" && hour === 12) {
    hour = 0;
  }
  return zonedInstant(date, `${pad(hour)}:${pad(minute)}`, timeZone);
}

type Field<T> = {
  /** The source column, lowercase — what reject reasons name. */
  readonly column: string;
  /** Other spellings the export may use, tried in order after the canonical name. */
  readonly aliases: readonly string[];
  /** The column must exist in the file AND carry a value in every data row. */
  readonly required: boolean;
  /** What the operator should see in a reject reason, e.g. "a calendar date". */
  readonly expects: string;
  /** Undefined = unparseable → the row is rejected. Input is already trimmed. */
  readonly read: (value: string) => T | undefined;
};

/** One field spec per adapter-filled column of the staged row, identity aside. */
type EntityMap<Row> = {
  readonly [K in keyof Omit<Row, "sourceIdentity">]-?: Field<NonNullable<Row[K]>>;
};

/**
 * How a row's `source_identity` is obtained. 4D gives one for two exports (the patient
 * `Id`, the consult's quote number) and none for the other two, where the adapter
 * DERIVES it (RECOVERY_DESIGN.md §3, DATA_MODEL.md).
 */
type Identity<Row> =
  | { readonly column: Field<string> }
  | { readonly derive: (row: Omit<Row, "sourceIdentity">) => readonly unknown[] };

type EntitySpec<Row> = {
  readonly map: EntityMap<Row>;
  readonly identity: Identity<Row>;
  /** Which columns the report-layout pre-pass carries group context into. */
  readonly carry?: CarrySpec;
};

/**
 * Columns that must never become a mapped field, whatever a future header turns up
 * (R0 (i), two-store rule): `Allergy` is clinical, `Description` and the revenue
 * line-item text are operator free text that can carry a visit reason, and `Report Tag`
 * is retail taxonomy we have no column for.
 */
export const NEVER_MAPPED: readonly string[] = [
  "allergy",
  "allergies",
  "description",
  "report tag",
];

/** Enforcement rather than convention: every field is built through `field` below, so a
 *  map that claimed an excluded column — as its name OR as an alias — cannot be
 *  constructed, and the adapter fails to build rather than staging what R0 excluded.
 *  Names are folded through header matching's OWN normalizer, so the guard cannot come to
 *  disagree with the matching it guards. */
function assertMappable(names: readonly string[]): void {
  const excluded = names.map(normalizeHeader).filter((name) => NEVER_MAPPED.includes(name));
  if (excluded.length > 0) {
    throw new Error(`4D column map may not claim an excluded column: ${excluded.join(", ")}`);
  }
}

const field = <T>(
  expects: string,
  read: (value: string) => T | undefined,
  column: string,
  required: boolean,
  aliases: readonly string[] = [],
): Field<T> => {
  assertMappable([column, ...aliases]);
  return { column, aliases, required, expects, read };
};

/** Exported for the test that pins the guard above onto the real construction path —
 *  every other field helper reaches `field` the same way this one does. */
export const text = (
  column: string,
  required: boolean,
  aliases: readonly string[] = [],
): Field<string> => field("text", (value) => value, column, required, aliases);

const dateField = (
  column: string,
  required: boolean,
  aliases: readonly string[] = [],
): Field<string> => field("a calendar date", calendarDate, column, required, aliases);

const centsField = (
  column: string,
  required: boolean,
  aliases: readonly string[] = [],
): Field<number> => field("a dollar amount", moneyCents, column, required, aliases);

const instantField = (
  column: string,
  timeZone: string,
  aliases: readonly string[] = [],
): Field<Date> =>
  field(
    "a practice-local date and time",
    (value) => practiceInstant(value, timeZone),
    column,
    true,
    aliases,
  );

/** 4D's exports, entity by entity. `inquiries` is absent by design (R0). */
type SupportedEntity = Exclude<StagedEntity, "inquiries">;
type EntitySpecs = { readonly [K in SupportedEntity]: EntitySpec<StagedRowByEntity[K]> };

function entitySpecs(timeZone: string): EntitySpecs {
  /** Patient Export (R0): first/last name, Id, DOB, email, phone + phone type, Spend.
   *  The export's ADDRESS columns are never mapped — the engine mails nobody, so they
   *  are data we would hold for nothing (data minimization, R0). */
  const patients: EntitySpec<StagedPatientRow> = {
    identity: { column: text("id", true, ["patient id", "patient #", "patient number"]) },
    map: {
      firstName: text("first name", false, ["first", "firstname"]),
      lastName: text("last name", false, ["last", "lastname"]),
      dob: dateField("dob", false, ["date of birth", "birth date", "birthdate"]),
      phone: text("phone", false, ["phone number", "primary phone", "cell", "mobile"]),
      phoneType: text("phone type", false, ["phone number type"]),
      email: text("email", false, ["e-mail", "email address"]),
      spendCents: centsField("spend", false, ["total spend", "lifetime spend"]),
    },
  };

  /** Detailed Appointment List — All Calendars (R0): date+time, provider, patient name,
   *  DOB, phone, Appt Type. No patient-id and no status column exist — `status` stays
   *  mapped as an optional upgrade, nothing depends on it. Provider arrives as a section
   *  row and the day as a separator row above rows that carry only a time; the pre-pass
   *  carries both down. Allergy and Description are NEVER mapped (see NEVER_MAPPED). */
  const appointments: EntitySpec<StagedAppointmentRow> = {
    // DERIVED identity: this export has no row id. sha256 over the row's normalized
    // identifying fields, plus an occurrence suffix (#2, #3 … in file order) that keeps
    // two genuinely identical printed rows apart.
    //
    // Only fields the ROW ITSELF prints are hashed. `providerRaw` is excluded although
    // it is staged: the export names the provider in a section row, so the value on a
    // row is INFERRED from where the page break happened to fall — a re-export that
    // paginates differently would change it, change the hash, and re-import the same
    // appointment as a duplicate. (The day carried onto `startAt` is not inferred: the
    // separator row states a real date the row's own time belongs to.) The cost is
    // accepted: two appointments identical in every printed field but their provider now
    // collide, and the occurrence suffix — already the rule for true duplicates — keeps
    // them apart.
    //
    // Reconciliation limits, accepted deliberately: the identity is only as stable as
    // the fields it hashes, so an appointment RESCHEDULED or whose phone is corrected in
    // 4D re-imports as a NEW row while the old one lingers (imports never delete), and
    // if one of several identical rows disappears from a later export the highest
    // occurrence suffix goes stale. Both are visible as unmatched staging rows, and
    // neither can double-count a recovery: attribution runs off the Medplum booking, not
    // off staging. A source that carries a real row id never has this problem.
    identity: {
      derive: (row) => [row.patientName, row.dob, row.phone, row.startAt, row.serviceCategoryRaw],
    },
    map: {
      patientSourceIdentity: text("patient id", false, ["patient number"]),
      patientName: text("patient", true, ["patient name", "name"]),
      dob: dateField("dob", false, ["date of birth", "birth date"]),
      phone: text("phone", false, ["phone number", "cell", "mobile"]),
      startAt: instantField("date/time", timeZone, [
        "date and time",
        "appt date/time",
        "date",
        "start",
        "start time",
        "time",
      ]),
      statusRaw: text("status", false, ["appt status", "appointment status"]),
      serviceCategoryRaw: text("appt type", false, [
        "appointment type",
        "appt type/location",
        "type",
      ]),
      providerRaw: text("provider", false, ["provider name", "calendar", "resource"]),
    },
    carry: { section: "provider", day: "date/time", patient: "patient" },
  };

  /** Conversion By Provider (R0): consult date (A), patient NAME only (D), quote number
   *  (G) as the row identity, provider (I), procedure (O), quote amount (R), booked (T),
   *  completed (W). Coordinator (N) and days-to-book (Y) are deliberately not staged.
   *  `outcome` stays mapped for a source that has one; this export has booked/completed
   *  instead and stages it null. */
  const consults: EntitySpec<StagedConsultRow> = {
    identity: { column: text("quote number", true, ["quote #", "quote no", "quote", "quote id"]) },
    map: {
      patientSourceIdentity: text("patient id", false, ["patient number"]),
      patientName: text("patient", true, ["patient name", "name"]),
      consultDate: dateField("consult date", true, ["date"]),
      serviceCategoryRaw: text("procedure", false, ["procedure name", "service"]),
      outcomeRaw: text("outcome", false, ["consult outcome"]),
      providerRaw: text("provider", false, ["provider name"]),
      quoteAmountCents: centsField("quote amount", false, ["quoted amount", "amount"]),
      bookedRaw: text("booked", false, ["booked?"]),
      completedRaw: text("completed", false, ["completed?"]),
    },
    // Provider arrives as a section row here too. No `patient` carry: this report has
    // no calendar blocks, so a consult row with no name is a broken row (the name is
    // its only join key) and must reject rather than vanish as structure.
    carry: { section: "provider" },
  };

  /** Revenue by Staff Incl. Procedure Prepayments (R0): DOS / paid date, patient Id,
   *  Category, amount. DOS wins where both date columns exist (alias order). The
   *  line-item description and Report Tag are NEVER mapped — there is no column to hold
   *  them, and the math needs only category + amount + date. */
  const transactions: EntitySpec<StagedTransactionRow> = {
    // DERIVED identity, same rule and the same limits as appointments above.
    identity: {
      derive: (row) => [
        row.patientSourceIdentity,
        row.transactionDate,
        row.serviceCategoryRaw,
        row.amountCents,
      ],
    },
    map: {
      patientSourceIdentity: text("id", false, ["patient id", "patient number"]),
      transactionDate: dateField("dos", true, [
        "date of service",
        "service date",
        "dos date",
        "paid date",
        "date paid",
        "transaction date",
        "date",
      ]),
      serviceCategoryRaw: text("category", false, ["category name"]),
      amountCents: centsField("amount", true, ["amount paid", "payment amount", "net amount"]),
    },
  };

  return { patients, appointments, consults, transactions };
}

/** The runtime shape of a spec, once the row type has done its checking. */
type AnyRow = Record<string, unknown>;
type AnySpec = {
  readonly map: Record<string, Field<unknown>>;
  readonly identity:
    | { readonly column: Field<string> }
    | { readonly derive: (row: AnyRow) => readonly unknown[] };
  readonly carry?: CarrySpec;
};

const columnsOf = (spec: AnySpec): ColumnSpec[] =>
  [...("column" in spec.identity ? [spec.identity.column] : []), ...Object.values(spec.map)].map(
    (f) => ({ canonical: f.column, names: [f.column, ...f.aliases], required: f.required }),
  );

/** Every source column name each entity's map claims, canonical names and aliases alike.
 *  The specs are literals inside `entitySpecs`, so this is how the NEVER_MAPPED test
 *  inspects what they actually claim. */
export function fourDColumnNames(timeZone: string): Record<SupportedEntity, readonly string[]> {
  const specs = entitySpecs(timeZone);
  const names = (spec: unknown): readonly string[] =>
    columnsOf(spec as AnySpec).flatMap((column) => column.names);
  return {
    patients: names(specs.patients),
    appointments: names(specs.appointments),
    consults: names(specs.consults),
    transactions: names(specs.transactions),
  };
}

/** One identifying field, normalized so the same row hashes the same next export:
 *  case-folded, whitespace-collapsed, and instants as UTC ISO. */
const identityPart = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value).trim().toLowerCase().replaceAll(/\s+/g, " ");
};

const derivedIdentity = (entity: string, parts: readonly unknown[]): string =>
  createHash("sha256")
    .update([entity, ...parts.map(identityPart)].join(" "))
    .digest("hex");

type RowResult<Row> = { ok: true; row: Row } | { ok: false; reason: string };

/** Applies one entity's column map to one record. Reasons name the COLUMN, never the
 *  value — the raw line is the rejects file's job. */
function buildRow(
  map: Record<string, Field<unknown>>,
  columnAt: ReadonlyMap<string, number>,
  record: readonly string[],
): RowResult<AnyRow> {
  const row: AnyRow = {};
  for (const [key, field] of Object.entries(map)) {
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
  return { ok: true, row };
}

export const FOUR_D_SOURCE_SYSTEM = "4d";

/** What 4D can produce. `inquiries` is absent: R0 found 4D tracks none. */
export const FOUR_D_ENTITIES: readonly StagedEntity[] = [
  "patients",
  "appointments",
  "consults",
  "transactions",
];

/**
 * The 4D adapter, bound to the practice timezone its export's wall times are written
 * in (the practice's own zone — the same value the clinical side carries on its
 * schedule actors; the CLI passes it explicitly rather than guessing).
 */
export function createFourDAdapter(timeZone: string): SourceAdapter {
  if (!isKnownTimeZone(timeZone)) {
    throw new UnknownTimeZoneError();
  }
  const specs = entitySpecs(timeZone) as Partial<Record<StagedEntity, unknown>>;

  return {
    sourceSystem: FOUR_D_SOURCE_SYSTEM,
    entities: FOUR_D_ENTITIES,

    parse<E extends StagedEntity>(entity: E, content: string): ParseResult<E> {
      const spec = specs[entity] as AnySpec | undefined;
      if (!spec) {
        throw new SourceFileError(`4D exports no ${entity} — this adapter cannot stage them`);
      }

      const file = normalizeReport(content, { columns: columnsOf(spec), carry: spec.carry });

      const rows: StagedRowByEntity[E][] = [];
      const rejects: RejectedRow[] = [];
      const seen = new Map<string, number>();
      for (const { line, raw, record } of file.rows) {
        // More fields than the header means a value has no column to belong to: every
        // column after the discrepancy may hold a neighbour's value. A SHORTER row is
        // read as trailing empties — report exporters truncate them, and a missing
        // required column still rejects below. Counts are safe to name.
        if (record.length > file.headers.length) {
          rejects.push({
            line,
            reason: `row has ${record.length} fields, header has ${file.headers.length}`,
            raw,
          });
          continue;
        }
        const result = buildRow(spec.map, file.columnAt, record);
        if (!result.ok) {
          rejects.push({ line, reason: result.reason, raw });
          continue;
        }

        let sourceIdentity: string;
        if ("column" in spec.identity) {
          const at = file.columnAt.get(spec.identity.column.column);
          sourceIdentity = (at === undefined ? "" : (record[at] ?? "")).trim();
          if (sourceIdentity === "") {
            rejects.push({ line, reason: `${spec.identity.column.column} is required`, raw });
            continue;
          }
          // The importer upserts the batch in one statement, so a source identity
          // repeated inside one file is a file-integrity problem, not a silent last-wins.
          if (seen.has(sourceIdentity)) {
            rejects.push({ line, reason: "duplicate source identity in this file", raw });
            continue;
          }
          seen.set(sourceIdentity, 1);
        } else {
          // Derived: identical rows are legitimate (a patient charged the same amount
          // twice in a day), so they are separated by occurrence rather than rejected.
          const base = derivedIdentity(entity, spec.identity.derive(result.row));
          const occurrence = (seen.get(base) ?? 0) + 1;
          seen.set(base, occurrence);
          sourceIdentity = occurrence === 1 ? base : `${base}#${occurrence}`;
        }

        rows.push({ ...result.row, sourceIdentity } as StagedRowByEntity[E]);
      }
      return {
        rows,
        rejects,
        layoutRowCount: file.layoutRowCount,
        declaredTotals: file.declaredTotals,
      };
    },
  };
}
