/**
 * SERVICE-CATEGORY SEED — LOCAL ONLY (docs/RECOVERY_DESIGN.md §7). Reads the staged
 * revenue rows and an operator-written cadence config, and writes `service_categories`:
 * the financial + cadence config the dormant pool and the Leak Report math run on.
 *
 *   pnpm --filter @medibun/api categories:seed -- --config ~/handal-exports/cadence.json
 *
 * Idempotent: the same export and config rewrite the same rows. The body lives in
 * src/recovery/cli.ts (where it is tested); this file is the composition root.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { errorLine, runSeedCategoriesCli, UsageError } from "../src/recovery/cli.js";

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
    await runSeedCategoriesCli({
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
