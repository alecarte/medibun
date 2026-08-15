/**
 * SERVICE-CATEGORY SEED — LOCAL ONLY (docs/RECOVERY_DESIGN.md §7). Reads the staged
 * revenue rows and an operator-written cadence config, and writes `service_categories`:
 * the financial + cadence config the dormant pool and the Leak Report math run on.
 *
 *   pnpm --filter @medibun/api categories:seed -- --config ~/handal-exports/cadence.json
 *
 * Idempotent: the same export and config rewrite the same rows. The body lives in
 * src/recovery/cli.ts (where it is tested) and the composition root in
 * src/local-script.ts, shared with the other local scripts.
 */
import { errorLine, runSeedCategoriesCli } from "../src/recovery/cli.js";
import { runLocalScript } from "../src/local-script.js";

await runLocalScript({ run: runSeedCategoriesCli, errorLine });
