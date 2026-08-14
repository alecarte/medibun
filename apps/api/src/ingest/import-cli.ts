import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { createFourDAdapter, FOUR_D_ENTITIES, UnknownTimeZoneError } from "./adapter-4d.js";
import { createImportService, type ImportSummary } from "./importer.js";
import { SourceFileError } from "./types.js";
import type { StagedEntity } from "../db/schema.js";

/**
 * The import CLI's body, separated from `scripts/import-4d.ts` so it can be tested:
 * this is the only component that writes raw source rows to disk and prints to a
 * terminal, which makes it exactly the component whose PHI discipline needs pinning.
 *
 * What the operator sees is counts, line numbers, and ids. What lands on disk is one
 * rejects file, replaced on every run and readable only by its owner. Nothing else.
 */

// Same driver-agnostic shape as importer.ts: node-postgres in prod, PGlite in tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<PgQueryResultHKT, any, any>;

/** Exactly what the 4D adapter can stage — `inquiries` is not among them (R0: 4D
 *  tracks none), and the usage line says so rather than failing halfway through. */
const ENTITIES: readonly StagedEntity[] = FOUR_D_ENTITIES;

export const USAGE = [
  "usage: pnpm --filter @medibun/api import:4d -- \\",
  `  --entity <${ENTITIES.join("|")}> --file <path> --timezone <IANA zone>`,
  "",
  "Keep exports OUTSIDE the repo (e.g. ~/handal-exports/roster.csv): the rejects file",
  "is written beside the input and carries raw source rows.",
  "",
  "--timezone is the PRACTICE's zone: 4D exports wall times with no offset, so the",
  "importer must be told which clock wrote them (reading them in the wrong zone moves",
  "appointments across days). It is required rather than defaulted for that reason.",
].join("\n");

/** The operator called this wrong, or the environment isn't ready. Safe to print in
 *  full: every message is written here, never derived from file content. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** First `code` in the error's cause chain (pg's SQLSTATE, node's ENOENT, …). Shared
 *  with the recovery CLIs, which apply the same failure-printing rule. */
export function errorCodeOf(err: unknown): string | undefined {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }
  return undefined;
}

/**
 * The one line a failure is allowed to print. ONLY our own typed errors are safe in
 * full: drizzle wraps a failed query as `Failed query: <sql> params: <bound values>`,
 * so a mid-batch database error would otherwise print up to a whole chunk of staged
 * names, dates of birth, phones, and emails to stderr. Everything else degrades to the
 * error's class name plus its driver code — enough to diagnose, nothing to leak.
 */
export function errorLine(err: unknown): string {
  if (
    err instanceof UsageError ||
    err instanceof SourceFileError ||
    err instanceof UnknownTimeZoneError
  ) {
    return err.message;
  }
  if (err instanceof Error) {
    const code = errorCodeOf(err);
    return `import failed: ${err.name}${code ? ` (${code})` : ""}`;
  }
  return "import failed";
}

/** Excel and Sheets execute a cell that opens with = + - @ (or a tab/CR before one).
 *  The rejects file exists to be opened by a human for triage, so such a cell is
 *  prefixed with an apostrophe: mangling one rejected value beats running it. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

const rejectCell = (value: string): string =>
  `"${(FORMULA_LEAD.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`;

/**
 * The per-file reconciliation line (R0 win (b)): 4D's exports print their own
 * `Total X = N`, so a run can be checked against the source with no side channel.
 * Subtotals print alongside a grand total, so the LARGEST declared number is the one
 * that should account for every data row. COUNTS ONLY — no label, no content — and a
 * mismatch is a warning, never a failure: the operator decides what it means.
 */
function reconciliationLine(summary: ImportSummary): string | undefined {
  if (summary.declaredTotals.length === 0) {
    return undefined;
  }
  const declared = Math.max(...summary.declaredTotals.map((total) => total.count));
  const accounted = summary.stagedCount + summary.rejectedCount;
  return declared === accounted
    ? `  file declares ${declared} · staged ${summary.stagedCount} + ` +
        `rejected ${summary.rejectedCount} ✓`
    : `  ⚠ file declares ${declared} · staged ${summary.stagedCount} + ` +
        `rejected ${summary.rejectedCount} (${Math.abs(declared - accounted)} unaccounted)`;
}

const readArg = (argv: readonly string[], name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

export type ImportCliRun = {
  readonly importId: string;
  readonly rejectsPath: string;
  readonly rejectedCount: number;
};

/**
 * Runs one import. The caller owns the connection (and closes it); this function owns
 * the file work. Throws UsageError / SourceFileError / UnknownTimeZoneError for the
 * operator, and whatever the driver throws otherwise — `errorLine` is what prints it.
 */
export async function runImportCli(deps: {
  readonly argv: readonly string[];
  readonly db: Db;
  readonly out: (line: string) => void;
}): Promise<ImportCliRun> {
  const entity = readArg(deps.argv, "entity");
  const file = readArg(deps.argv, "file");
  const timezone = readArg(deps.argv, "timezone");
  if (!entity || !file || !timezone || !ENTITIES.includes(entity as StagedEntity)) {
    throw new UsageError(USAGE);
  }

  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (err) {
    // Not the raw error: its message embeds the path, and a captured terminal log
    // shouldn't carry the directory a real export was filed under.
    throw new UsageError(`could not read the input file (${errorCodeOf(err) ?? "unreadable"})`);
  }

  const adapter = createFourDAdapter(timezone);
  const rejectsPath = `${file}.rejects.csv`;
  // Always clear the previous run's rejects FIRST. It holds raw source rows: a clean
  // re-import must not leave a stale one beside a ledger row that says the run was
  // clean, and removing before writing is also what makes the 0600 mode apply (mode is
  // honored on create only, so an existing world-readable file would keep its own).
  rmSync(rejectsPath, { force: true });

  const summary = await createImportService({ db: deps.db }).runImport({
    adapter,
    entity: entity as StagedEntity,
    fileName: basename(file),
    content,
    rejectsUri: rejectsPath,
  });

  if (summary.rejects.length > 0) {
    const rows = summary.rejects.map((r) =>
      [String(r.line), r.reason, r.raw].map(rejectCell).join(","),
    );
    writeFileSync(rejectsPath, ["line,reason,raw", ...rows].join("\n") + "\n", { mode: 0o600 });
  }

  deps.out(`✓ imported ${basename(file)} as ${entity} (import ${summary.importId})`);
  deps.out(
    `  ${summary.rowCount} rows · ${summary.insertedCount} new · ` +
      `${summary.updatedCount} reconciled · ${summary.rejectedCount} rejected`,
  );
  if (summary.layoutRowCount > 0) {
    // Report furniture the pre-pass skipped: preamble, section and day rows, totals,
    // reprinted headers, non-patient calendar blocks. Counted, never rejected.
    deps.out(`  ${summary.layoutRowCount} report-layout rows skipped`);
  }
  const reconciliation = reconciliationLine(summary);
  if (reconciliation) {
    deps.out(reconciliation);
  }
  if (summary.rejects.length > 0) {
    // Basename only, same rule as the ledger columns and the unreadable-input error:
    // captured terminal output must not carry the directory an export was filed under.
    deps.out(`  ${basename(rejectsPath)} written beside the input (raw rows — keep it local)`);
  }
  return {
    importId: summary.importId,
    rejectsPath,
    rejectedCount: summary.rejectedCount,
  };
}
