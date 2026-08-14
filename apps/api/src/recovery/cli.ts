import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  ConfigError,
  parseCadenceConfig,
  seedServiceCategories,
  type SeedSummary,
} from "./categories.js";
import {
  buildLeakReport,
  formatDollars,
  NoStagedRevenueError,
  renderLeakReport,
  type LeakReportData,
} from "./leak-report.js";
import { CALENDAR_DATE } from "./segmentation.js";
import { errorCodeOf, UsageError } from "../ingest/import-cli.js";

/**
 * The two recovery CLIs' bodies, separated from `scripts/` so they can be tested — the
 * same split as `ingest/import-cli.ts`, and for the same reason: these are the components
 * that print to a terminal and write to disk, so these are the ones whose PHI discipline
 * needs pinning.
 *
 * What the operator sees is counts, dollars, and CATEGORY LABELS — the practice's own
 * menu vocabulary, never a patient value. What lands on disk is one aggregates-only
 * report, readable by its owner.
 */

// Same driver-agnostic shape as importer.ts: node-postgres in prod, PGlite in tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<PgQueryResultHKT, any, any>;

export { UsageError };

/**
 * The one line a failure is allowed to print, on the same rule as the import CLI: only
 * our own typed errors are safe in full, because a driver error's message embeds the
 * failed query and its bound parameters. Everything else degrades to a class name and a
 * driver code — enough to diagnose, nothing to leak.
 */
export function errorLine(err: unknown): string {
  if (
    err instanceof UsageError ||
    err instanceof ConfigError ||
    err instanceof NoStagedRevenueError
  ) {
    return err.message;
  }
  if (err instanceof Error) {
    const code = errorCodeOf(err);
    return `command failed: ${err.name}${code ? ` (${code})` : ""}`;
  }
  return "command failed";
}

const readArg = (argv: readonly string[], name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

/** Reads a file for the operator without letting its path reach the terminal: a
 *  directory a human chose can itself name a patient. */
function readLocalFile(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new UsageError(`could not read the ${what} (${errorCodeOf(err) ?? "unreadable"})`);
  }
}

export const SEED_CATEGORIES_USAGE = [
  "usage: pnpm --filter @medibun/api categories:seed -- --config <path>",
  "",
  "Computes each category's typical ticket from the staged revenue rows and writes",
  "service_categories. The config supplies the part the data cannot: expected-return",
  "intervals are hand-set clinical-cadence judgment, never derived. A category absent",
  "from the config defines no dormancy and stays out of the pool.",
  "",
  '  { "categories": { "<label or code>": { "expectedReturnIntervalDays": 120 } } }',
  "",
  "config/service-categories.example.json is a synthetic example. The real one describes",
  "a practice's menu — keep it outside the repo with the exports.",
].join("\n");

export async function runSeedCategoriesCli(deps: {
  readonly argv: readonly string[];
  readonly db: Db;
  readonly out: (line: string) => void;
}): Promise<SeedSummary> {
  const configPath = readArg(deps.argv, "config");
  if (!configPath) {
    throw new UsageError(SEED_CATEGORIES_USAGE);
  }

  const config = parseCadenceConfig(readLocalFile(configPath, "cadence config"));
  const summary = await seedServiceCategories(deps.db, config);

  deps.out(
    `✓ seeded ${summary.categories.length} service categories ` +
      `(${summary.fromRevenue} from revenue · ${summary.fromConfigOnly} from the config only)`,
  );
  deps.out(
    `  ${summary.withInterval} define an expected-return interval · ` +
      `${summary.visitCount} visits sampled`,
  );
  if (summary.rowsWithoutCategory > 0 || summary.rowsWithoutPatient > 0) {
    deps.out(
      `  ${summary.rowsWithoutCategory} revenue rows carry no category · ` +
        `${summary.rowsWithoutPatient} carry no patient id`,
    );
  }
  if (summary.nonPositiveVisits > 0) {
    deps.out(`  ${summary.nonPositiveVisits} visits netted to nothing and were not averaged`);
  }
  // Category labels are the practice's own menu vocabulary — printable, unlike anything
  // patient-level. The interval column is what the operator is really checking.
  const width = Math.max(0, ...summary.categories.map((c) => c.display.length));
  for (const category of summary.categories) {
    const interval =
      category.expectedReturnIntervalDays === null
        ? "no dormancy"
        : `${category.expectedReturnIntervalDays}d`;
    const ticket =
      category.typicalTicketCents === null
        ? "no ticket"
        : `${formatDollars(category.typicalTicketCents)} ${category.ticketBasis}`;
    deps.out(
      `  ${category.display.padEnd(width)}  ${interval.padStart(11)}  ${ticket} ` +
        `(${category.visitCount} visits)`,
    );
  }
  return summary;
}

export const LEAK_REPORT_USAGE = [
  "usage: pnpm --filter @medibun/api report:leak -- --out <path> [options]",
  "",
  "  --out <path>          where to write the report (required)",
  "  --practice <name>     practice display name in the header",
  "  --as-of <YYYY-MM-DD>  anchor date; defaults to the newest staged transaction",
  "  --min-age-days <n>    how old an unbooked consult must be to count as lost",
  "",
  "The report is aggregates only — no patient name, identifier, or contact detail can",
  "appear in it. It is still the practice's confidential diagnostic: write it outside",
  "the repo (e.g. ~/handal-exports/leak-report.html) and deliver it directly.",
].join("\n");

export type LeakReportRun = {
  readonly outPath: string;
  readonly data: LeakReportData;
};

export async function runLeakReportCli(deps: {
  readonly argv: readonly string[];
  readonly db: Db;
  readonly out: (line: string) => void;
}): Promise<LeakReportRun> {
  const outPath = readArg(deps.argv, "out");
  if (!outPath) {
    throw new UsageError(LEAK_REPORT_USAGE);
  }
  const asOf = readArg(deps.argv, "as-of");
  if (asOf !== undefined && !CALENDAR_DATE.test(asOf)) {
    throw new UsageError("--as-of must be a calendar date, written YYYY-MM-DD");
  }
  const rawMinAge = readArg(deps.argv, "min-age-days");
  const minAgeDays = rawMinAge === undefined ? undefined : Number(rawMinAge);
  if (minAgeDays !== undefined && (!Number.isInteger(minAgeDays) || minAgeDays < 0)) {
    throw new UsageError("--min-age-days must be a whole number of days");
  }

  const data = await buildLeakReport(deps.db, {
    ...(readArg(deps.argv, "practice") === undefined
      ? {}
      : { practiceName: readArg(deps.argv, "practice")! }),
    ...(asOf === undefined ? {} : { asOf }),
    ...(minAgeDays === undefined ? {} : { minAgeDays }),
  });

  try {
    writeFileSync(outPath, renderLeakReport(data), { mode: 0o600 });
    // mode is honored on CREATE only — overwriting a pre-existing world-readable file
    // would silently keep its looser permissions, so re-assert after every write.
    chmodSync(outPath, 0o600);
  } catch (err) {
    throw new UsageError(`could not write the report (${errorCodeOf(err) ?? "unwritable"})`);
  }

  // Basename only, same rule as the import CLI's output: captured terminal output must
  // not carry the directory a practice's file was filed under.
  deps.out(`✓ ${basename(outPath)} written (as of ${data.asOf})`);
  deps.out(
    `  dormant: ${data.dormant.opportunityCount} opportunities · ` +
      `${data.dormant.patientCount} patients · ${formatDollars(data.dormant.expectedValueCents)}`,
  );
  deps.out(
    `  unconverted consults: ${data.consults.poolCount} · ` +
      `${formatDollars(data.consults.quotedValueCents)} quoted`,
  );
  deps.out(`  identified: ${formatDollars(data.headlineCents)}`);
  return { outPath, data };
}
