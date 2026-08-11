/**
 * 4D IMPORT CLI — LOCAL ONLY (docs/RECOVERY_DESIGN.md §7: until every touched service
 * has its BAA, real exports and real staging live only on practice-controlled hardware,
 * against the local docker stack). This script does exactly that: it reads a file from
 * disk and writes to EXPERIENCE_DATABASE_URL. Nothing leaves the machine.
 *
 *   pnpm --filter @medibun/api import:4d -- \
 *     --entity patients --file ./roster.csv --timezone America/New_York
 *
 * Prints counts and line numbers only. Rejected rows — the one place raw source content
 * appears — go to `<file>.rejects.csv` beside the input, owner-readable, never to
 * stdout and never to the database. Re-running the same export is idempotent; every run
 * appends an `imports` ledger row either way.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { createFourDAdapter } from "../src/ingest/adapter-4d.js";
import { createImportService } from "../src/ingest/importer.js";
import type { StagedEntity } from "../src/db/schema.js";

const ENTITIES: readonly StagedEntity[] = ["patients", "appointments", "inquiries", "consults"];

const USAGE = [
  "usage: pnpm --filter @medibun/api import:4d -- \\",
  `  --entity <${ENTITIES.join("|")}> --file <path> --timezone <IANA zone>`,
  "",
  "--timezone is the PRACTICE's zone: 4D exports wall times with no offset, so the",
  "importer must be told which clock wrote them (reading them in the wrong zone moves",
  "appointments across days). It is required rather than defaulted for that reason.",
].join("\n");

/** `--name value` lookup — no argument-parsing dependency for four flags. */
function readArg(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

/** One RFC-4180 cell for the rejects file. */
const csvCell = (value: string): string => `"${value.replaceAll('"', '""')}"`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const entity = readArg(argv, "entity");
  const file = readArg(argv, "file");
  const timezone = readArg(argv, "timezone");
  if (!entity || !file || !timezone || !ENTITIES.includes(entity as StagedEntity)) {
    throw new Error(USAGE);
  }
  const dbUrl = process.env.EXPERIENCE_DATABASE_URL;
  if (!dbUrl) {
    throw new Error(
      "EXPERIENCE_DATABASE_URL unset — start the local stack first:\n" +
        "  cd infra/medplum && docker compose up -d && ./setup-dev.sh",
    );
  }

  const content = readFileSync(file, "utf8");
  const rejectsPath = `${file}.rejects.csv`;
  const adapter = createFourDAdapter(timezone);

  const pool = new pg.Pool({ connectionString: dbUrl });
  let summary;
  try {
    summary = await createImportService({ db: drizzle(pool) }).runImport({
      adapter,
      entity: entity as StagedEntity,
      fileName: basename(file),
      content,
      rejectsUri: rejectsPath,
    });
  } finally {
    await pool.end();
  }

  if (summary.rejects.length > 0) {
    const rows = summary.rejects.map((r) =>
      [String(r.line), r.reason, r.raw].map(csvCell).join(","),
    );
    // 0o600: the rejects file is the only artifact carrying raw source rows.
    writeFileSync(rejectsPath, ["line,reason,raw", ...rows].join("\n") + "\n", { mode: 0o600 });
  }

  console.log(`✓ imported ${basename(file)} as ${entity} (import ${summary.importId})`);
  console.log(
    `  ${summary.rowCount} rows · ${summary.insertedCount} new · ` +
      `${summary.updatedCount} reconciled · ${summary.rejectedCount} rejected`,
  );
  if (summary.rejects.length > 0) {
    console.log(`  rejects written to ${rejectsPath} (raw rows — keep it local)`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
