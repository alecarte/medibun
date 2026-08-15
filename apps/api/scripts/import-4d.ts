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
 * is tested) and the composition root — environment, connection, exit code — in
 * src/local-script.ts, shared with the other local scripts.
 */
import { errorLine, runImportCli } from "../src/ingest/import-cli.js";
import { runLocalScript } from "../src/local-script.js";

await runLocalScript({ run: runImportCli, errorLine });
