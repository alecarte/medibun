import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { serviceCategories, stagedTransactions } from "../db/schema.js";

/**
 * Service-category seeding (R2c, RECOVERY_DESIGN.md §3). Two numbers per category, from
 * two deliberately different places:
 *
 * - `typical_ticket_cents` is COMPUTED from the revenue export. A visit is the sum of a
 *   patient's line items on one date in one category (refunds net in), and the typical
 *   ticket is the average visit total — the R0 finding that actual per-category averages
 *   supersede the price list, because list prices exclude anesthesia and facility fees.
 * - `expected_return_interval_days` is HAND-SET and never derived. Clinical cadence is
 *   judgment, not a statistic you can read out of transactions; the operator supplies it
 *   as a JSON config, and a category absent from that config defines no dormancy at all.
 *
 * Nothing here prints or returns a patient value: the outputs are category labels (the
 * practice's own menu vocabulary) and counts.
 */

// Same driver-agnostic shape as importer.ts: node-postgres in prod, PGlite in tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<PgQueryResultHKT, any, any>;

export type TicketBasis = NonNullable<(typeof serviceCategories.$inferSelect)["ticketBasis"]>;

/** The revenue columns the ticket math reads — nothing else is selected. */
export type TransactionInput = {
  readonly patientSourceIdentity: string | null;
  readonly transactionDate: string;
  readonly serviceCategoryRaw: string | null;
  readonly amountCents: number;
};

/**
 * The category's primary key: the source label, folded to a slug. Case and punctuation
 * vary between 4D's exports (Revenue prints `Skin Care / Peels`, the config may be
 * written `skin-care-peels`), so both sides slug before they meet. A label that slugs to
 * nothing — punctuation only — keeps its folded self as the code rather than collapsing
 * every such category onto one empty key.
 */
export function categoryCode(label: string): string {
  const folded = label.trim().toLowerCase();
  const slug = folded
    .replaceAll(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return slug === "" ? folded.replaceAll(/\s+/g, "") : slug;
}

export type CategoryTicket = {
  readonly code: string;
  readonly display: string;
  /** Visits the average was taken over — the sample size behind the number. */
  readonly visitCount: number;
  readonly typicalTicketCents: number;
};

export type TicketSummary = {
  readonly categories: readonly CategoryTicket[];
  /** Rows with no category label: nothing to attribute them to. */
  readonly rowsWithoutCategory: number;
  /** Rows with no patient id: the export's non-patient rows (R0). */
  readonly rowsWithoutPatient: number;
  /** Visit groups netting to zero or less. A standalone refund is a real row but not a
   *  visit, and counting it would drag the ticket down twice — once in the sum, once in
   *  the denominator. Counted here so the report can state the exclusion. */
  readonly nonPositiveVisits: number;
};

/** One visit = one patient, one date, one category. The revenue export is line-level. */
const visitKey = (patient: string, date: string, code: string): string =>
  `${patient}\u0000${date}\u0000${code}`;

/**
 * Groups the revenue export into per-visit tickets and averages them per category.
 * Pure: same rows in, same numbers out — the whole point of the report's methodology
 * note is that this calculation can be re-run and checked.
 */
export function typicalTickets(rows: readonly TransactionInput[]): TicketSummary {
  const visits = new Map<string, { code: string; cents: number }>();
  const displays = new Map<string, string>();
  let rowsWithoutCategory = 0;
  let rowsWithoutPatient = 0;

  for (const row of rows) {
    const label = row.serviceCategoryRaw?.trim() ?? "";
    if (label === "") {
      rowsWithoutCategory += 1;
      continue;
    }
    if (!row.patientSourceIdentity) {
      rowsWithoutPatient += 1;
      continue;
    }
    const code = categoryCode(label);
    // First spelling seen wins the display: two labels that slug alike are one category.
    if (!displays.has(code)) {
      displays.set(code, label);
    }
    const key = visitKey(row.patientSourceIdentity, row.transactionDate, code);
    const visit = visits.get(key) ?? { code, cents: 0 };
    visit.cents += row.amountCents;
    visits.set(key, visit);
  }

  const totals = new Map<string, { count: number; cents: number }>();
  let nonPositiveVisits = 0;
  for (const visit of visits.values()) {
    if (visit.cents <= 0) {
      nonPositiveVisits += 1;
      continue;
    }
    const total = totals.get(visit.code) ?? { count: 0, cents: 0 };
    total.count += 1;
    total.cents += visit.cents;
    totals.set(visit.code, total);
  }

  const categories = [...totals.entries()]
    .map(([code, total]) => ({
      code,
      display: displays.get(code)!,
      visitCount: total.count,
      typicalTicketCents: Math.round(total.cents / total.count),
    }))
    .sort((a, b) => a.display.localeCompare(b.display));

  return { categories, rowsWithoutCategory, rowsWithoutPatient, nonPositiveVisits };
}

/** The operator's cadence config is unreadable. Safe to print in full: every message is
 *  written here, and the only source text it names is a category label — the practice's
 *  menu vocabulary, never a patient value. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type CadenceEntry = {
  /** The operator's spelling, kept as the display for a category revenue never saw. */
  readonly display: string;
  /** Null = this category defines no dormancy (retail, garments). */
  readonly expectedReturnIntervalDays: number | null;
  /** Optional override for a category with no usable revenue history. */
  readonly typicalTicketCents?: number;
};

/** Category code → the operator's hand-set cadence. */
export type CadenceConfig = ReadonlyMap<string, CadenceEntry>;

/** Ten years: past this, "expected return" is not a cadence, it is a typo. */
const MAX_INTERVAL_DAYS = 3650;

const isWholeNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);

/**
 * Reads the operator's cadence config: `{ "categories": { "<label or code>": { … } } }`.
 * Keys are slugged, so the operator can write 4D's label or our code and mean the same
 * category. Everything is validated up front — a config typo must fail before it silently
 * removes a whole category from the dormant pool.
 */
export function parseCadenceConfig(content: string): CadenceConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ConfigError("the cadence config is not valid JSON");
  }
  const categories = (parsed as { categories?: unknown } | null)?.categories;
  if (typeof categories !== "object" || categories === null || Array.isArray(categories)) {
    throw new ConfigError('the cadence config needs a "categories" object at its root');
  }

  const config = new Map<string, CadenceEntry>();
  for (const [label, raw] of Object.entries(categories as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ConfigError(`${label}: expected an object of settings`);
    }
    const entry = raw as { expectedReturnIntervalDays?: unknown; typicalTicketCents?: unknown };
    const interval = entry.expectedReturnIntervalDays;
    if (interval !== null && !isWholeNumber(interval)) {
      throw new ConfigError(
        `${label}: expectedReturnIntervalDays must be a whole number of days, or null for a ` +
          "category that defines no dormancy",
      );
    }
    if (interval !== null && (interval < 1 || interval > MAX_INTERVAL_DAYS)) {
      throw new ConfigError(
        `${label}: expectedReturnIntervalDays must be between 1 and ${MAX_INTERVAL_DAYS} days`,
      );
    }
    const ticket = entry.typicalTicketCents;
    if (ticket !== undefined && (!isWholeNumber(ticket) || ticket < 0)) {
      throw new ConfigError(`${label}: typicalTicketCents must be a whole number of cents`);
    }
    const code = categoryCode(label);
    if (config.has(code)) {
      throw new ConfigError(`${label}: two entries name the same category (${code})`);
    }
    config.set(code, {
      display: label.trim(),
      expectedReturnIntervalDays: interval,
      ...(ticket === undefined ? {} : { typicalTicketCents: ticket }),
    });
  }
  return config;
}

export type SeededCategory = {
  readonly code: string;
  readonly display: string;
  readonly expectedReturnIntervalDays: number | null;
  readonly typicalTicketCents: number | null;
  readonly ticketBasis: TicketBasis | null;
  /** Visits behind a revenue-average ticket; zero for a config-only category. */
  readonly visitCount: number;
};

export type SeedSummary = {
  readonly categories: readonly SeededCategory[];
  /** Categories the revenue export produced a ticket for. */
  readonly fromRevenue: number;
  /** Categories that exist only because the config names them. */
  readonly fromConfigOnly: number;
  /** Categories that define dormancy — the rest are excluded from the pool by design. */
  readonly withInterval: number;
  readonly visitCount: number;
  readonly rowsWithoutCategory: number;
  readonly rowsWithoutPatient: number;
  readonly nonPositiveVisits: number;
};

/** Merges the computed tickets with the operator's config. The config is authoritative
 *  for cadence: a category dropped from it goes back to defining no dormancy. */
function merge(tickets: TicketSummary, config: CadenceConfig): SeededCategory[] {
  const rows = new Map<string, SeededCategory>();
  for (const ticket of tickets.categories) {
    const entry = config.get(ticket.code);
    rows.set(ticket.code, {
      code: ticket.code,
      display: ticket.display,
      expectedReturnIntervalDays: entry?.expectedReturnIntervalDays ?? null,
      typicalTicketCents: entry?.typicalTicketCents ?? ticket.typicalTicketCents,
      ticketBasis: entry?.typicalTicketCents === undefined ? "revenue-average" : "hand-set",
      visitCount: ticket.visitCount,
    });
  }
  for (const [code, entry] of config) {
    if (rows.has(code)) {
      continue;
    }
    rows.set(code, {
      code,
      display: entry.display,
      expectedReturnIntervalDays: entry.expectedReturnIntervalDays,
      typicalTicketCents: entry.typicalTicketCents ?? null,
      ticketBasis: entry.typicalTicketCents === undefined ? null : "hand-set",
      visitCount: 0,
    });
  }
  return [...rows.values()].sort((a, b) => a.display.localeCompare(b.display));
}

/**
 * Computes the tickets from staged revenue, merges the operator's cadence config over
 * them, and upserts `service_categories`. Idempotent by `code`: re-running with the same
 * export and config rewrites the same rows.
 */
export async function seedServiceCategories(db: Db, config: CadenceConfig): Promise<SeedSummary> {
  const rows = await db
    .select({
      patientSourceIdentity: stagedTransactions.patientSourceIdentity,
      transactionDate: stagedTransactions.transactionDate,
      serviceCategoryRaw: stagedTransactions.serviceCategoryRaw,
      amountCents: stagedTransactions.amountCents,
    })
    .from(stagedTransactions);

  const tickets = typicalTickets(rows);
  const categories = merge(tickets, config);

  if (categories.length > 0) {
    await db
      .insert(serviceCategories)
      .values(
        categories.map((category) => ({
          code: category.code,
          display: category.display,
          expectedReturnIntervalDays: category.expectedReturnIntervalDays,
          typicalTicketCents: category.typicalTicketCents,
          ticketBasis: category.ticketBasis,
        })),
      )
      .onConflictDoUpdate({
        target: serviceCategories.code,
        set: {
          display: sql`excluded.display`,
          expectedReturnIntervalDays: sql`excluded.expected_return_interval_days`,
          typicalTicketCents: sql`excluded.typical_ticket_cents`,
          ticketBasis: sql`excluded.ticket_basis`,
          updatedAt: new Date(),
        },
      });
  }

  return {
    categories,
    fromRevenue: tickets.categories.length,
    fromConfigOnly: categories.length - tickets.categories.length,
    withInterval: categories.filter((c) => c.expectedReturnIntervalDays !== null).length,
    visitCount: tickets.categories.reduce((sum, c) => sum + c.visitCount, 0),
    rowsWithoutCategory: tickets.rowsWithoutCategory,
    rowsWithoutPatient: tickets.rowsWithoutPatient,
    nonPositiveVisits: tickets.nonPositiveVisits,
  };
}
