import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  groupVisits,
  selectStagedTransactions,
  type TicketBasis,
  type TransactionInput,
} from "./categories.js";
import { currentImportIds } from "../ingest/importer.js";
import {
  serviceCategories,
  stagedAppointments,
  stagedConsults,
  stagedPatients,
} from "../db/schema.js";
import { zonedYmd } from "../staff.js";

/**
 * Pool segmentation (R2c, RECOVERY_DESIGN.md §1). Two pools, both as R0 found them:
 *
 * - **Dormant / lapsed** — the primary pool, driven by REVENUE rather than appointment
 *   status, because 4D's appointment export carries no status column: a patient whose
 *   last PAID visit in a category is older than that category's expected-return interval,
 *   and who holds no appointment after the as-of date.
 * - **Unconverted consults** — degraded by construction (R0): the source report covers
 *   quote-created surgical consults only, and carries a patient NAME with no id, DOB, or
 *   phone to disambiguate it. Every degradation is counted rather than smoothed over.
 *
 * Everything below is a typed aggregate. Nothing here prints, logs, or returns a patient
 * value — the caller gets counts, category labels, and dollars, which is exactly what the
 * Leak Report is allowed to say.
 *
 * The whole snapshot is read once and the pools compute over it in memory: two years of a
 * single practice is tens of thousands of rows, and pure functions over a snapshot are
 * what make each pool rule testable without a database.
 */

// Same driver-agnostic shape as importer.ts: node-postgres in prod, PGlite in tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<PgQueryResultHKT, any, any>;

export type RosterRow = {
  readonly sourceIdentity: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly dob: string | null;
  readonly phone: string | null;
  readonly email: string | null;
};

export type AppointmentRow = {
  readonly patientSourceIdentity: string | null;
  readonly patientName: string | null;
  readonly dob: string | null;
  readonly phone: string | null;
  readonly startAt: Date;
};

export type ConsultRow = {
  readonly patientSourceIdentity: string | null;
  readonly patientName: string;
  readonly consultDate: string;
  readonly quoteAmountCents: number | null;
  readonly bookedRaw: string | null;
};

export type CategoryRow = {
  readonly code: string;
  readonly display: string;
  readonly expectedReturnIntervalDays: number | null;
  readonly typicalTicketCents: number | null;
  readonly ticketBasis: TicketBasis | null;
};

/** Rows staging still holds that the latest import of their export no longer contains —
 *  excluded from the snapshot above, counted here so the report can state the exclusion
 *  instead of quietly making it. */
export type SupersededCounts = {
  readonly patients: number;
  readonly appointments: number;
  readonly consults: number;
  readonly transactions: number;
};

/** One read of staging; both pools compute from it. */
export type StagingSnapshot = {
  readonly patients: readonly RosterRow[];
  readonly appointments: readonly AppointmentRow[];
  readonly consults: readonly ConsultRow[];
  readonly transactions: readonly TransactionInput[];
  readonly categories: readonly CategoryRow[];
  readonly superseded: SupersededCounts;
};

const DAY_MS = 86_400_000;

/** Whole days between two calendar dates. Dates only — no clock, so no DST to carry. */
const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * A name folded to a comparison key: lowercased, punctuation dropped, and the tokens
 * SORTED. The roster prints first and last name in two columns while the appointment and
 * consult reports print one string whose order 4D does not promise ("Fakeman, Testerly"),
 * so an order-dependent key would silently lose most of the join. R0 recorded column
 * meanings rather than exact spellings; the same tolerance applies to the values.
 */
export function nameKey(value: string): string {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((part) => part !== "")
    .sort()
    .join(" ");
}

const digitsOnly = (value: string): string => value.replaceAll(/\D+/g, "");

/** The appointment export's only join key: name + DOB + phone, all three (R0). */
const tripleKey = (name: string, dob: string, phone: string): string | undefined => {
  const key = nameKey(name);
  const digits = digitsOnly(phone);
  return key === "" || dob === "" || digits === "" ? undefined : `${key}|${dob}|${digits}`;
};

/** Yes-shaped and no-shaped labels a `Booked` column may print. Deliberately closed
 *  sets: the first local run pins the real vocabulary, and until then a label outside
 *  them is counted as uninterpretable rather than read as a lost consult. */
const BOOKED_YES = new Set(["yes", "y", "true", "1", "booked", "x", "✓", "checked"]);
const BOOKED_NO = new Set(["no", "n", "false", "0", "not booked", "unbooked"]);

/**
 * Reads a `booked` label. `undefined` means the label carries no answer we can stand
 * behind — a blank cell included. Guessing here would put a patient who did book into an
 * outreach campaign, which is the one mistake this engine cannot make.
 */
export function readBooked(raw: string | null): boolean | undefined {
  const value = (raw ?? "").trim().toLowerCase().replaceAll(/\s+/g, " ");
  if (BOOKED_YES.has(value)) {
    return true;
  }
  return BOOKED_NO.has(value) ? false : undefined;
}

/** The export's own horizon: its newest transaction date. Anchoring on the data rather
 *  than on today keeps a report reproducible against a fixed export. */
export function defaultAsOf(snapshot: StagingSnapshot): string | undefined {
  let latest: string | undefined;
  for (const row of snapshot.transactions) {
    if (latest === undefined || row.transactionDate > latest) {
      latest = row.transactionDate;
    }
  }
  return latest;
}

/** The newest paid visit one patient made in one category. */
export type LastPaidVisit = {
  readonly patient: string;
  readonly code: string;
  readonly date: string;
};

/** One patient's paid visits: the newest per category, plus the newest in any category.
 *  Grouped by `categories.ts`'s own `groupVisits` — a visit is one patient, one date, one
 *  category, netted, the same grouping the ticket math averages over, so both numbers
 *  mean one thing. A group that nets to nothing is a refund, not a visit. */
export type PaidVisits = {
  readonly lastByCategory: readonly LastPaidVisit[];
  readonly lastAny: ReadonlyMap<string, string>;
};

function paidVisits(transactions: readonly TransactionInput[]): PaidVisits {
  const lastByCategory = new Map<string, { patient: string; code: string; date: string }>();
  const lastAny = new Map<string, string>();
  for (const visit of groupVisits(transactions).visits) {
    if (visit.cents <= 0) {
      continue;
    }
    const key = `${visit.patient} ${visit.code}`;
    const last = lastByCategory.get(key);
    if (last === undefined) {
      lastByCategory.set(key, { patient: visit.patient, code: visit.code, date: visit.date });
    } else if (last.date < visit.date) {
      last.date = visit.date;
    }
    if ((lastAny.get(visit.patient) ?? "") < visit.date) {
      lastAny.set(visit.patient, visit.date);
    }
  }
  return { lastByCategory: [...lastByCategory.values()], lastAny };
}

/** Roster lookups: by the source's patient id, by the appointment triple, by name alone
 *  (the consult report's only option). A key claimed by more than one patient is
 *  AMBIGUOUS and resolves to nothing — never to a guess (R0). */
export type RosterIndex = {
  readonly byIdentity: ReadonlyMap<string, RosterRow>;
  readonly byTriple: ReadonlyMap<string, readonly string[]>;
  readonly byName: ReadonlyMap<string, readonly string[]>;
};

/** Appends to a collision list in place. Rebuilding the list per collision would make
 *  indexing a roster quadratic in its largest set of same-key patients. */
const addTo = (index: Map<string, string[]>, key: string, identity: string): void => {
  const identities = index.get(key);
  if (identities === undefined) {
    index.set(key, [identity]);
  } else {
    identities.push(identity);
  }
};

function indexRoster(patients: readonly RosterRow[]): RosterIndex {
  const byIdentity = new Map<string, RosterRow>();
  const byTriple = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  for (const row of patients) {
    byIdentity.set(row.sourceIdentity, row);
    const full = `${row.firstName ?? ""} ${row.lastName ?? ""}`;
    const key = nameKey(full);
    if (key !== "") {
      addTo(byName, key, row.sourceIdentity);
    }
    const triple = tripleKey(full, row.dob ?? "", row.phone ?? "");
    if (triple !== undefined) {
      addTo(byTriple, triple, row.sourceIdentity);
    }
  }
  return { byIdentity, byTriple, byName };
}

const only = (matches: readonly string[] | undefined): string | undefined =>
  matches?.length === 1 ? matches[0] : undefined;

export type AppointmentJoin = {
  readonly rows: number;
  /** Rows resolved to a roster patient, by id or by the name+DOB+phone triple. */
  readonly resolvedRows: number;
};

/** Patients holding an appointment after the as-of date, plus how well the join ran. */
function futureAppointments(
  appointments: readonly AppointmentRow[],
  roster: RosterIndex,
  asOf: string,
  timeZone: string,
): { readonly patients: ReadonlySet<string>; readonly join: AppointmentJoin } {
  // "After the as-of date" is a CALENDAR claim, so it is decided on calendar days: the
  // day the appointment falls on in the PRACTICE's zone, compared as text against the
  // as-of date. Read in UTC the comparison is wrong east of UTC, where that day has
  // already ended — the mistake that matters, because it contacts a patient who already
  // holds a booking. An instant BOUND would be right in most zones and wrong in the ones
  // whose clocks skip midnight: a spring-forward day with no 00:00 makes "the start of
  // the following day" resolve to 23:00, and the last hour of the as-of evening reads as
  // tomorrow. Comparing days carries no arithmetic to get wrong.
  const patients = new Set<string>();
  let resolvedRows = 0;

  for (const row of appointments) {
    const triple =
      row.patientName === null
        ? undefined
        : tripleKey(row.patientName, row.dob ?? "", row.phone ?? "");
    const identity =
      row.patientSourceIdentity ??
      (triple === undefined ? undefined : only(roster.byTriple.get(triple)));
    if (identity === undefined) {
      continue;
    }
    resolvedRows += 1;
    // Strictly after: the as-of day itself is not future, and any later practice-local
    // day is — midnight the morning after included, whatever the clocks did that night.
    if (zonedYmd(row.startAt, timeZone) > asOf) {
      patients.add(identity);
    }
  }

  return { patients, join: { rows: appointments.length, resolvedRows } };
}

/** Everything both pools read: the roster index, the netted paid visits, and the
 *  future-appointment join. Each is a full pass over the snapshot, and each is identical
 *  between the pools — computed once, the Leak Report makes every pass once. */
export type SnapshotIndexes = {
  readonly roster: RosterIndex;
  readonly visits: PaidVisits;
  /** Patients holding an appointment after the as-of date — the exclusion set. */
  readonly futurePatients: ReadonlySet<string>;
  readonly appointmentJoin: AppointmentJoin;
};

/** The shared passes, done once. Bound to `asOf` AND to the practice's zone: the
 *  future-appointment join is measured from the as-of day as that practice's clock ends
 *  it, so indexes must not be carried across either. */
export function prepareIndexes(
  snapshot: StagingSnapshot,
  asOf: string,
  timeZone: string,
): SnapshotIndexes {
  const roster = indexRoster(snapshot.patients);
  const future = futureAppointments(snapshot.appointments, roster, asOf, timeZone);
  return {
    roster,
    visits: paidVisits(snapshot.transactions),
    futurePatients: future.patients,
    appointmentJoin: future.join,
  };
}

export type DormantCategory = {
  readonly code: string;
  readonly display: string;
  readonly expectedReturnIntervalDays: number;
  readonly typicalTicketCents: number | null;
  readonly ticketBasis: TicketBasis | null;
  /** Dormant patients in this category — one opportunity each. */
  readonly patientCount: number;
  readonly expectedValueCents: number;
};

export type Contactability = {
  readonly withPhone: number;
  readonly withEmail: number;
  /** Phone or email — the campaign can work only these. Phone and email overlap. */
  readonly withEither: number;
  readonly withNeither: number;
  /** Pooled by revenue but absent from the roster export: contactability unknown. */
  readonly notInRoster: number;
};

export type DormantPool = {
  readonly asOf: string;
  readonly categories: readonly DormantCategory[];
  /** Patient × category — what the campaign would actually work. */
  readonly opportunityCount: number;
  /** Distinct patients behind those opportunities. */
  readonly patientCount: number;
  readonly expectedValueCents: number;
  readonly contactability: Contactability;
  readonly appointmentJoin: AppointmentJoin;
  /** Patients dropped because they already hold a future appointment. */
  readonly excludedByFutureAppointment: number;
  /** Categories in the pool with no ticket value — their opportunities are counted but
   *  contribute nothing to the dollars, which the report says in those words. */
  readonly categoriesWithoutTicket: number;
};

/**
 * The dormant pool. `asOf` anchors everything: dormancy is measured from it, and a visit
 * exactly `interval` days old is NOT yet dormant — the interval has only just come due.
 *
 * `indexes` is the shared work, passed in when the caller already did it (the Leak Report
 * runs both pools) and done here when the pool is called on its own.
 */
export function dormantPool(
  snapshot: StagingSnapshot,
  options: { readonly asOf: string; readonly timeZone: string },
  indexes: SnapshotIndexes = prepareIndexes(snapshot, options.asOf, options.timeZone),
): DormantPool {
  const { asOf } = options;
  const categories = new Map(
    snapshot.categories
      .filter((c) => c.expectedReturnIntervalDays !== null)
      .map((c) => [c.code, c]),
  );

  const perCategory = new Map<string, Set<string>>();
  const pooled = new Set<string>();
  const excluded = new Set<string>();

  for (const { patient, code, date } of indexes.visits.lastByCategory) {
    const category = categories.get(code);
    if (!category || daysBetween(date, asOf) <= category.expectedReturnIntervalDays!) {
      continue;
    }
    if (indexes.futurePatients.has(patient)) {
      excluded.add(patient);
      continue;
    }
    perCategory.set(code, (perCategory.get(code) ?? new Set()).add(patient));
    pooled.add(patient);
  }

  const rows = [...perCategory.entries()]
    .map(([code, patients]) => {
      const category = categories.get(code)!;
      return {
        code,
        display: category.display,
        expectedReturnIntervalDays: category.expectedReturnIntervalDays!,
        typicalTicketCents: category.typicalTicketCents,
        ticketBasis: category.ticketBasis,
        patientCount: patients.size,
        expectedValueCents: patients.size * (category.typicalTicketCents ?? 0),
      };
    })
    .sort(
      (a, b) => b.expectedValueCents - a.expectedValueCents || a.display.localeCompare(b.display),
    );

  let withPhone = 0;
  let withEmail = 0;
  let withEither = 0;
  let notInRoster = 0;
  for (const identity of pooled) {
    const row = indexes.roster.byIdentity.get(identity);
    if (!row) {
      notInRoster += 1;
      continue;
    }
    const phone = (row.phone ?? "").trim() !== "";
    const email = (row.email ?? "").trim() !== "";
    withPhone += phone ? 1 : 0;
    withEmail += email ? 1 : 0;
    withEither += phone || email ? 1 : 0;
  }

  return {
    asOf,
    categories: rows,
    opportunityCount: rows.reduce((sum, row) => sum + row.patientCount, 0),
    patientCount: pooled.size,
    expectedValueCents: rows.reduce((sum, row) => sum + row.expectedValueCents, 0),
    contactability: {
      withPhone,
      withEmail,
      withEither,
      withNeither: pooled.size - notInRoster - withEither,
      notInRoster,
    },
    appointmentJoin: indexes.appointmentJoin,
    excludedByFutureAppointment: excluded.size,
    categoriesWithoutTicket: rows.filter((row) => row.typicalTicketCents === null).length,
  };
}

/** A consult younger than this is not lost yet, it is in flight. */
export const DEFAULT_CONSULT_MIN_AGE_DAYS = 30;

export type ConsultPool = {
  readonly asOf: string;
  readonly minAgeDays: number;
  readonly poolCount: number;
  readonly quotedValueCents: number;
  /** Pooled consults the export quoted no dollars for — counted, never valued at zero. */
  readonly withoutQuoteCount: number;
  readonly bookedCount: number;
  readonly tooRecentCount: number;
  /** Resolved to a patient who returned another way (a later paid visit or a future
   *  appointment). The honesty section's number — the mirror of B8's own exclusion. */
  readonly excludedReturnedCount: number;
  /** The name matched more than one roster patient: a human resolves it, we do not. */
  readonly ambiguousNameCount: number;
  /** The `booked` label carried no answer we could stand behind. */
  readonly uninterpretableCount: number;
  /** Pooled, but the name matched no roster row — so "did they come back?" is unanswered
   *  and the consult is kept rather than dropped. */
  readonly unresolvedNameCount: number;
};

/**
 * The unconverted-consult pool. Degraded by the source (R0): quote-created surgical
 * consults only, joined to the roster by NAME alone. Each degradation gets its own
 * counter so the report can state it rather than imply a completeness it does not have.
 */
export function unconvertedConsults(
  snapshot: StagingSnapshot,
  options: { readonly asOf: string; readonly timeZone: string; readonly minAgeDays?: number },
  indexes: SnapshotIndexes = prepareIndexes(snapshot, options.asOf, options.timeZone),
): ConsultPool {
  const { asOf } = options;
  const minAgeDays = options.minAgeDays ?? DEFAULT_CONSULT_MIN_AGE_DAYS;

  let poolCount = 0;
  let quotedValueCents = 0;
  let withoutQuoteCount = 0;
  let bookedCount = 0;
  let tooRecentCount = 0;
  let excludedReturnedCount = 0;
  let ambiguousNameCount = 0;
  let uninterpretableCount = 0;
  let unresolvedNameCount = 0;

  for (const row of snapshot.consults) {
    const booked = readBooked(row.bookedRaw);
    if (booked === undefined) {
      uninterpretableCount += 1;
      continue;
    }
    if (booked) {
      bookedCount += 1;
      continue;
    }
    if (daysBetween(row.consultDate, asOf) < minAgeDays) {
      tooRecentCount += 1;
      continue;
    }

    const key = nameKey(row.patientName);
    const matches = indexes.roster.byName.get(key) ?? [];
    const identity = row.patientSourceIdentity ?? only(matches);
    if (identity === undefined) {
      if (matches.length > 1) {
        ambiguousNameCount += 1;
        continue;
      }
      unresolvedNameCount += 1;
    } else {
      const lastPaid = indexes.visits.lastAny.get(identity);
      if (
        (lastPaid !== undefined && lastPaid > row.consultDate) ||
        indexes.futurePatients.has(identity)
      ) {
        excludedReturnedCount += 1;
        continue;
      }
    }

    poolCount += 1;
    if (row.quoteAmountCents === null) {
      withoutQuoteCount += 1;
    } else {
      quotedValueCents += row.quoteAmountCents;
    }
  }

  return {
    asOf,
    minAgeDays,
    poolCount,
    quotedValueCents,
    withoutQuoteCount,
    bookedCount,
    tooRecentCount,
    excludedReturnedCount,
    ambiguousNameCount,
    uninterpretableCount,
    unresolvedNameCount,
  };
}

/**
 * Rows the LATEST import of their export still contains, and a count of the rest.
 * Staging never deletes, so a corrected or voided source line leaves its old row behind —
 * and for the two exports with derived identities the correction stages as a NEW row, so
 * both spellings of one visit would net together and inflate every number downstream.
 * `currentImportIds` is the rule and carries its assumption (each export is a full dump of
 * its range); this is where the exclusion is counted so the report can state it.
 */
const currentRows = <T extends { readonly importId: string }>(
  rows: readonly T[],
  current: ReadonlySet<string>,
): { readonly rows: readonly T[]; readonly superseded: number } => {
  const kept = rows.filter((row) => current.has(row.importId));
  return { rows: kept, superseded: rows.length - kept.length };
};

/** Reads staging once, selecting only the columns the pools compute from. */
export async function readStaging(db: Db): Promise<StagingSnapshot> {
  const current = await currentImportIds(db);
  const [patients, appointments, consults, transactions, categories] = await Promise.all([
    db
      .select({
        sourceIdentity: stagedPatients.sourceIdentity,
        firstName: stagedPatients.firstName,
        lastName: stagedPatients.lastName,
        dob: stagedPatients.dob,
        phone: stagedPatients.phone,
        email: stagedPatients.email,
        importId: stagedPatients.importId,
      })
      .from(stagedPatients),
    db
      .select({
        patientSourceIdentity: stagedAppointments.patientSourceIdentity,
        patientName: stagedAppointments.patientName,
        dob: stagedAppointments.dob,
        phone: stagedAppointments.phone,
        startAt: stagedAppointments.startAt,
        importId: stagedAppointments.importId,
      })
      .from(stagedAppointments),
    db
      .select({
        patientSourceIdentity: stagedConsults.patientSourceIdentity,
        patientName: stagedConsults.patientName,
        consultDate: stagedConsults.consultDate,
        quoteAmountCents: stagedConsults.quoteAmountCents,
        bookedRaw: stagedConsults.bookedRaw,
        importId: stagedConsults.importId,
      })
      .from(stagedConsults),
    selectStagedTransactions(db),
    db
      .select({
        code: serviceCategories.code,
        display: serviceCategories.display,
        expectedReturnIntervalDays: serviceCategories.expectedReturnIntervalDays,
        typicalTicketCents: serviceCategories.typicalTicketCents,
        ticketBasis: serviceCategories.ticketBasis,
      })
      .from(serviceCategories),
  ]);

  const roster = currentRows(patients, current);
  const booked = currentRows(appointments, current);
  const quoted = currentRows(consults, current);
  const paid = currentRows(transactions, current);
  return {
    patients: roster.rows,
    appointments: booked.rows,
    consults: quoted.rows,
    transactions: paid.rows,
    categories,
    superseded: {
      patients: roster.superseded,
      appointments: booked.superseded,
      consults: quoted.superseded,
      transactions: paid.superseded,
    },
  };
}
