import { rmSync, writeFileSync } from "node:fs";
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
import { calendarDate, isKnownTimeZone } from "../ingest/dates.js";
import {
  errorCodeOf,
  makeErrorLine,
  readArg,
  readLocalFile,
  UsageError,
} from "../ingest/import-cli.js";

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
 * The one line a failure is allowed to print, built from the import CLI's shared rule:
 * only our own typed errors are safe in full, because a driver error's message embeds the
 * failed query and its bound parameters. Everything else degrades to a class name and a
 * driver code — enough to diagnose, nothing to leak.
 */
export const errorLine = makeErrorLine(
  [UsageError, ConfigError, NoStagedRevenueError],
  "command failed",
);

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
  "usage: pnpm --filter @medibun/api report:leak -- \\",
  "  --out <path> --timezone <IANA zone> [options]",
  "",
  "  --out <path>            where to write the report (required)",
  "  --timezone <IANA zone>  the practice's own zone (required)",
  "  --practice <name>       practice display name in the header",
  "  --as-of <YYYY-MM-DD>    anchor date; defaults to the newest staged transaction",
  "  --min-age-days <n>      how old an unbooked consult must be to count as lost",
  "",
  "--timezone is the PRACTICE's zone, required for the same reason the import CLI",
  "requires it: staging holds instants, and every date this report prints is the local",
  "calendar day one fell on (reading them in the wrong zone moves an evening",
  "appointment across days). It is required rather than defaulted for that reason.",
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
  const timeZone = readArg(deps.argv, "timezone");
  if (!outPath || !timeZone) {
    throw new UsageError(LEAK_REPORT_USAGE);
  }
  if (!isKnownTimeZone(timeZone)) {
    throw new UsageError("--timezone must be an IANA zone name, e.g. America/New_York");
  }
  // A SHAPE check is not a validation: "2026-13-01" matches YYYY-MM-DD, reads as NaN, and
  // then quietly inverts every date comparison the pools make. The value is not echoed
  // back — the operator typed it, and the flag plus what it expects is what fixes a typo.
  const rawAsOf = readArg(deps.argv, "as-of");
  const asOf = rawAsOf === undefined ? undefined : calendarDate(rawAsOf);
  if (rawAsOf !== undefined && asOf === undefined) {
    throw new UsageError("--as-of must be a real calendar date, written YYYY-MM-DD");
  }
  const rawMinAge = readArg(deps.argv, "min-age-days");
  if (rawMinAge !== undefined && !/^\d+$/.test(rawMinAge.trim())) {
    throw new UsageError("--min-age-days must be a whole number of days");
  }
  const minAgeDays = rawMinAge === undefined ? undefined : Number(rawMinAge);
  const practiceName = readArg(deps.argv, "practice");

  const data = await buildLeakReport(deps.db, {
    timeZone,
    ...(practiceName === undefined ? {} : { practiceName }),
    ...(asOf === undefined ? {} : { asOf }),
    ...(minAgeDays === undefined ? {} : { minAgeDays }),
  });

  // Rendered BEFORE the write is attempted: a template bug is not a disk problem, and
  // reporting it as one sends the operator looking in the wrong place.
  const document = renderLeakReport(data);
  try {
    // Clear any previous report FIRST, the same posture as the import CLI's rejects file:
    // `mode` is honored on create only, so writing over a file already there would leave
    // a confidential document sitting at whatever permissions it had — and a chmod after
    // the fact leaves it exposed for as long as the write takes, or forever if the chmod
    // is the call that fails.
    rmSync(outPath, { force: true });
    writeFileSync(outPath, document, { mode: 0o600 });
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
