/**
 * 4D IMPORT CLI — LOCAL ONLY (docs/RECOVERY_DESIGN.md §7: until every touched service
 * has its BAA, real exports and real staging live only on practice-controlled hardware,
 * against the local docker stack). This script does exactly that: it reads a file from
 * disk and writes to EXPERIENCE_DATABASE_URL. Nothing leaves the machine.
 *
 *   pnpm --filter @medibun/api import:4d -- \
 *     --entity patients --file ~/handal-exports/roster.csv --timezone America/New_York
 *
 * Keep exports outside the repo. The body lives in src/ingest/import-cli.ts (where it
 * is tested); this file is the composition root: environment, connection, exit code.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { errorLine, runImportCli, UsageError } from "../src/ingest/import-cli.js";

async function main(): Promise<void> {
  const dbUrl = process.env.EXPERIENCE_DATABASE_URL;
  if (!dbUrl) {
    throw new UsageError(
      "EXPERIENCE_DATABASE_URL unset — start the local stack first:\n" +
        "  cd infra/medplum && docker compose up -d && ./setup-dev.sh",
    );
  }
  const pool = new pg.Pool({ connectionString: dbUrl });
  try {
    await runImportCli({
      argv: process.argv.slice(2),
      db: drizzle(pool),
      out: (line) => console.log(line),
    });
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  // errorLine, never the raw error: a driver failure's message carries bound parameters.
  console.error(errorLine(err));
  process.exit(1);
});
