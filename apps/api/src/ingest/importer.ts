import { createHash } from "node:crypto";

import { and, asc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type { PgColumn, PgDatabase, PgQueryResultHKT, PgTable } from "drizzle-orm/pg-core";

import type { DeclaredTotal, RejectedRow, SourceAdapter } from "./types.js";
import {
  imports,
  stagedAppointments,
  stagedConsults,
  stagedInquiries,
  stagedPatients,
  stagedTransactions,
  type StagedEntity,
} from "../db/schema.js";

/**
 * The import service (RECOVERY_DESIGN.md §2): the only part of ingestion that touches
 * the database. It hashes the export, appends a row to the `imports` run ledger, and
 * upserts the adapter's rows by `(source_system, source_identity)` — a fresh export
 * supersedes the last one, so a re-import reconciles in place instead of duplicating.
 * Every run appends a ledger row even when nothing changed: that ledger is the
 * reconciliation evidence behind attribution claims.
 *
 * PHI discipline: rejected rows are RETURNED to the caller (the CLI writes them to a
 * local rejects file) and never written to any column, logged, or put in an error.
 */

// Same driver-agnostic shape as catalog.ts: node-postgres in prod, PGlite in tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<PgQueryResultHKT, any, any>;

/** What every staging table has in common — the pair this service keys on. The
 *  entity-specific columns are the adapter's business, handled structurally below. */
type StagingTable = PgTable & {
  readonly sourceSystem: PgColumn;
  readonly sourceIdentity: PgColumn;
};

const STAGING_TABLES: Record<StagedEntity, StagingTable> = {
  patients: stagedPatients,
  appointments: stagedAppointments,
  inquiries: stagedInquiries,
  consults: stagedConsults,
  transactions: stagedTransactions,
};

/** Rows per statement. A 24-month appointment export runs to tens of thousands of
 *  rows; Postgres caps a statement at 65535 bind parameters. */
const UPSERT_CHUNK = 500;

/** Columns an upsert never refreshes from the incoming export: the pair it matched on,
 *  the row's own key and creation stamp, and the two columns this service sets itself. */
const NEVER_REFRESHED = new Set([
  "id",
  "sourceSystem",
  "sourceIdentity",
  "createdAt",
  "importId",
  "updatedAt",
]);

export type ImportSummary = {
  readonly importId: string;
  /** Data rows read from the file = staged + rejected. */
  readonly rowCount: number;
  readonly stagedCount: number;
  readonly insertedCount: number;
  readonly updatedCount: number;
  readonly rejectedCount: number;
  readonly rejects: readonly RejectedRow[];
  /** Report-layout rows the adapter skipped (preamble, sections, totals, calendar
   *  blocks). Not staged, not rejected — reported so the operator sees them. */
  readonly layoutRowCount: number;
  /** The file's own `Total X = N` rows, for the CLI's per-file reconciliation. */
  readonly declaredTotals: readonly DeclaredTotal[];
};

export type ImportRequest<E extends StagedEntity> = {
  readonly adapter: SourceAdapter;
  readonly entity: E;
  /** Recorded in the ledger; reduced to a basename so no local path is stored. */
  readonly fileName: string;
  readonly content: string;
  /** Where the caller will write rejects. Stored — as a basename, same reason as
   *  fileName — only if the run produced any. */
  readonly rejectsUri?: string;
};

export type ImportService = {
  /** Parses, then stages in one transaction. Throws SourceFileError (from the adapter)
   *  when the file cannot be staged at all — nothing is written in that case. */
  readonly runImport: <E extends StagedEntity>(request: ImportRequest<E>) => Promise<ImportSummary>;
};

/**
 * The run stamp a CURRENT staged row carries: the latest import per (source system,
 * entity). The upsert above re-stamps `import_id` on every row a fresh export contains,
 * so a row still carrying an older run's stamp is precisely a row the newest export no
 * longer has — a line voided or corrected at the source, whose replacement staged under a
 * new derived identity while the original stayed behind (imports never delete).
 *
 * This holds only while each export is a FULL dump of its date range, which is what R0
 * recorded (the revenue re-pull covers the whole 24-month window). A narrower re-pull
 * would eclipse every row outside its range, which is why every reader counts what it
 * excluded rather than filtering quietly.
 */
export async function currentImportIds(db: Db): Promise<ReadonlySet<string>> {
  const runs = await db
    .select({ id: imports.id, sourceSystem: imports.sourceSystem, entity: imports.entity })
    .from(imports)
    .orderBy(asc(imports.createdAt));

  const latest = new Map<string, string>();
  for (const run of runs) {
    latest.set(`${run.sourceSystem}\u0000${run.entity}`, run.id);
  }
  return new Set(latest.values());
}

/** Path chain out, filename in: a directory a human chose can itself name a patient
 *  ("~/exports/jane-doe/roster.csv"), so nothing path-shaped reaches a column. */
const fileNameOnly = (value: string): string => value.split(/[\\/]/).pop() || value;

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

export function createImportService(deps: { readonly db: Db }): ImportService {
  return {
    async runImport(request) {
      const { rows, rejects, layoutRowCount, declaredTotals } = request.adapter.parse(
        request.entity,
        request.content,
      );
      const table: StagingTable = STAGING_TABLES[request.entity];
      const columns: Record<string, PgColumn> = getTableColumns(table);
      const sourceSystem = request.adapter.sourceSystem;
      const values = rows as readonly Record<string, unknown>[];
      const identities = values.map((row) => String(row.sourceIdentity));

      return deps.db.transaction(async (tx) => {
        // Which identities already exist decides new-vs-reconciled in the summary; it
        // reads inside the transaction so the counts match what the upsert then does.
        const known = new Set<string>();
        for (const batch of chunk(identities, UPSERT_CHUNK)) {
          const existing = await tx
            .select({ sourceIdentity: table.sourceIdentity })
            .from(table)
            .where(and(eq(table.sourceSystem, sourceSystem), inArray(table.sourceIdentity, batch)));
          for (const row of existing) {
            known.add(String(row.sourceIdentity));
          }
        }

        const [run] = await tx
          .insert(imports)
          .values({
            sourceSystem,
            entity: request.entity,
            fileName: fileNameOnly(request.fileName),
            fileHash: createHash("sha256").update(request.content).digest("hex"),
            rowCount: values.length + rejects.length,
            stagedCount: values.length,
            rejectedCount: rejects.length,
            rejectsUri:
              rejects.length > 0 && request.rejectsUri ? fileNameOnly(request.rejectsUri) : null,
          })
          .returning({ id: imports.id });
        const importId = run!.id;

        // Everything the adapter filled is refreshed from the incoming export; the
        // run stamp and updatedAt come from this run. id/createdAt stay put.
        //
        // Which columns those are is read from the TABLE — the same schema source the
        // conflict target uses — intersected with the keys this batch actually fills.
        // Neither half is enough on its own: the schema alone would refresh a column no
        // adapter fills, and `excluded.medplum_patient_id` is null on every upsert, so a
        // promoted identity link would be cleared by a routine re-import; one sample row
        // alone would silently drop a column that row happens to omit, leaving a stale
        // value behind a ledger row that says the run reconciled.
        const filled = new Set(values.flatMap((row) => Object.keys(row)));
        const set: Record<string, unknown> = {
          importId,
          updatedAt: new Date(),
        };
        for (const [key, column] of Object.entries(columns)) {
          if (!filled.has(key) || NEVER_REFRESHED.has(key)) {
            continue;
          }
          set[key] = sql`excluded.${sql.identifier(column.name)}`;
        }

        for (const batch of chunk(values, UPSERT_CHUNK)) {
          await tx
            .insert(table)
            .values(batch.map((row) => ({ ...row, sourceSystem, importId })))
            .onConflictDoUpdate({
              target: [table.sourceSystem, table.sourceIdentity],
              set,
            });
        }

        const updatedCount = identities.filter((identity) => known.has(identity)).length;
        return {
          importId,
          rowCount: values.length + rejects.length,
          stagedCount: values.length,
          insertedCount: values.length - updatedCount,
          updatedCount,
          rejectedCount: rejects.length,
          rejects,
          layoutRowCount,
          declaredTotals,
        };
      });
    },
  };
}
