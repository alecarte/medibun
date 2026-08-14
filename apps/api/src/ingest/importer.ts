import { createHash } from "node:crypto";

import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
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
        const set: Record<string, unknown> = {
          importId,
          updatedAt: new Date(),
        };
        for (const key of Object.keys(values[0] ?? {})) {
          if (key === "sourceIdentity") {
            continue;
          }
          set[key] = sql`excluded.${sql.identifier(columns[key]!.name)}`;
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
