/**
 * LEAK REPORT — LOCAL ONLY (docs/RECOVERY_DESIGN.md §7: the report is generated locally
 * and delivered directly). Reads staging plus `service_categories` and writes one
 * self-contained, print-quality HTML document.
 *
 *   pnpm --filter @medibun/api report:leak -- \
 *     --out ~/handal-exports/leak-report.html --practice "Handal Plastic Surgery"
 *
 * The document is aggregates only — category labels, counts, dollars — and carries no
 * patient name, identifier, or contact detail. It is still practice-confidential: write
 * it outside the repo. The body lives in src/recovery/cli.ts (where it is tested).
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { errorLine, runLeakReportCli, UsageError } from "../src/recovery/cli.js";

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
    await runLeakReportCli({
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
