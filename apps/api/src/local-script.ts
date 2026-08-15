import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";

import { UsageError } from "./ingest/import-cli.js";

/**
 * The composition root the LOCAL-ONLY scripts share (docs/RECOVERY_DESIGN.md §7): the
 * environment guard, one pool against EXPERIENCE_DATABASE_URL, and the exit code. Each
 * file under `scripts/` is then nothing but the CLI body it runs.
 *
 * The failure posture is the reason this is one function rather than three copies: a
 * failure prints the CLI's own `errorLine` and NEVER the raw error, because a driver
 * failure's message carries the failed query and its bound parameters — a whole chunk of
 * staged names, dates of birth, phones, and emails.
 */

// Same driver-agnostic shape as importer.ts: node-postgres in prod, PGlite in tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<PgQueryResultHKT, any, any>;

export type LocalScriptCli = {
  /** The CLI body — `runImportCli`, `runSeedCategoriesCli`, `runLeakReportCli`. */
  readonly run: (deps: {
    readonly argv: readonly string[];
    readonly db: Db;
    readonly out: (line: string) => void;
  }) => Promise<unknown>;
  /** That CLI's own scrubbed failure line. */
  readonly errorLine: (err: unknown) => string;
};

export async function runLocalScript(cli: LocalScriptCli): Promise<void> {
  try {
    const dbUrl = process.env.EXPERIENCE_DATABASE_URL;
    if (!dbUrl) {
      throw new UsageError(
        "EXPERIENCE_DATABASE_URL unset — start the local stack first:\n" +
          "  cd infra/medplum && docker compose up -d && ./setup-dev.sh",
      );
    }
    const pool = new pg.Pool({ connectionString: dbUrl });
    try {
      await cli.run({
        argv: process.argv.slice(2),
        db: drizzle(pool),
        out: (line) => console.log(line),
      });
    } finally {
      await pool.end();
    }
  } catch (err) {
    console.error(cli.errorLine(err));
    process.exit(1);
  }
}
