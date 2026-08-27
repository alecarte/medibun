/**
 * LEAK REPORT — LOCAL ONLY (docs/RECOVERY_DESIGN.md §7: the report is generated locally
 * and delivered directly). Reads staging plus `service_categories` and writes one
 * self-contained, print-quality HTML document.
 *
 *   pnpm --filter @medibun/api report:leak -- \
 *     --out ~/handal-exports/leak-report.html --practice "Handal Plastic Surgery" \
 *     --timezone America/New_York
 *
 * The document is aggregates only — category labels, counts, dollars — and carries no
 * patient name, identifier, or contact detail. It is still practice-confidential: write
 * it outside the repo. The body lives in src/recovery/cli.ts (where it is tested) and the
 * composition root in src/local-script.ts, shared with the other local scripts.
 */
import { errorLine, runLeakReportCli } from "../src/recovery/cli.js";
import { runLocalScript } from "../src/local-script.js";

await runLocalScript({ run: runLeakReportCli, errorLine });
