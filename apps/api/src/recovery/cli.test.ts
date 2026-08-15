import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ConfigError } from "./categories.js";
import { errorLine, runLeakReportCli, runSeedCategoriesCli, UsageError } from "./cli.js";
import { NoStagedRevenueError } from "./leak-report.js";
import { createFourDAdapter } from "../ingest/adapter-4d.js";
import { createImportService } from "../ingest/importer.js";
import { csvFile, ymd } from "../ingest/test-fixtures.js";
import { bootTestDb } from "../db/test-db.js";

/**
 * The recovery CLIs' terminal discipline, on the same posture as the import CLI suite:
 * what a failure is allowed to print, and what the argument guards refuse before any
 * work starts. Every fixture value is synthetic (test-fixtures.ts).
 */

const TZ = "America/New_York";

/**
 * The renderer, made to fail on demand. Rendering happens BEFORE the write is attempted,
 * so a template bug has to surface as itself: reported as a write failure it would send
 * an operator hunting a disk that is fine.
 */
const render = vi.hoisted(() => ({ fails: false }));
vi.mock("./leak-report.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./leak-report.js")>();
  return {
    ...actual,
    renderLeakReport: (data: Parameters<typeof actual.renderLeakReport>[0]) => {
      if (render.fails) {
        throw new TypeError("value.replaceAll is not a function");
      }
      return actual.renderLeakReport(data);
    },
  };
});

/** Synthetic values distinctive enough that any leak into output is unmistakable. */
const LEAKY = {
  first: "Zzyzxine",
  last: "Quibbleworth",
  phone: "555-0177",
  email: "leaky@example.invalid",
};

let db: ReturnType<typeof drizzle>;
let dir: string;

const leakReport = (argv: readonly string[]) => runLeakReportCli({ argv, db, out: () => {} });

// One PGlite boot per file (shared helper); explicit budget for cold CI runners.
beforeAll(async () => {
  db = await bootTestDb();
  dir = mkdtempSync(join(tmpdir(), "medibun-recovery-"));

  const importer = createImportService({ db });
  const adapter = createFourDAdapter(TZ);
  await importer.runImport({
    adapter,
    entity: "patients",
    fileName: "roster.csv",
    content: csvFile(
      ["Id", "First Name", "Last Name", "DOB", "Phone", "Email"],
      [["p-1", LEAKY.first, LEAKY.last, ymd(1970, 4, 12), LEAKY.phone, LEAKY.email]],
    ),
  });
  // Revenue gives the report a horizon to anchor on; without it there is nothing to say.
  await importer.runImport({
    adapter,
    entity: "transactions",
    fileName: "revenue.csv",
    content: csvFile(
      ["DOS", "Id", "Category", "Amount"],
      [[ymd(2026, 5, 1), "p-1", "Example Injectables", "500.00"]],
    ),
  });
}, 60_000);

describe("recovery CLIs — what a failure prints", () => {
  it("prints our own typed errors in full", () => {
    expect(errorLine(new UsageError("--out is required"))).toBe("--out is required");
    expect(errorLine(new ConfigError("the cadence config is not valid JSON"))).toBe(
      "the cadence config is not valid JSON",
    );
    expect(errorLine(new NoStagedRevenueError())).toContain("no revenue rows are staged");
    expect(errorLine("not an error at all")).toBe("command failed");
  });

  it("scrubs a database failure down to its class and driver code", async () => {
    await db.execute(sql`ALTER TABLE staged_patients DROP COLUMN email`);

    let thrown: unknown;
    try {
      await leakReport(["--out", join(dir, "leak-report.html"), "--timezone", TZ]);
    } catch (err) {
      thrown = err;
    } finally {
      await db.execute(sql`ALTER TABLE staged_patients ADD COLUMN email text`);
    }

    // The hazard this guards: drizzle's own message carries the failed query, and on a
    // write path its bound parameters with it.
    expect((thrown as Error).message).toContain("staged_patients");
    const line = errorLine(thrown);
    expect(line).toBe("command failed: Error (42703)");
    expect(line).not.toContain("staged_patients");
    for (const value of Object.values(LEAKY)) {
      expect(line).not.toContain(value);
    }
  });

  it("lets a rendering failure surface as itself, not as a write failure", async () => {
    const outPath = join(dir, "unrendered.html");
    render.fails = true;

    const err = await leakReport(["--out", outPath, "--timezone", TZ]).catch(
      (thrown: unknown) => thrown,
    );
    render.fails = false;

    expect(err).not.toBeInstanceOf(UsageError);
    expect(errorLine(err)).not.toContain("could not write the report");
    // A template bug is ours, but its message is not written here — it degrades like any
    // other untyped error, to a class name.
    expect(errorLine(err)).toBe("command failed: TypeError");
    expect(existsSync(outPath)).toBe(false);
  });

  it("reports an unreadable config without echoing the path it tried", async () => {
    const missing = join(dir, "handal-exports", "no-such-cadence.json");

    const err = await runSeedCategoriesCli({
      argv: ["--config", missing],
      db,
      out: () => {},
    }).catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(UsageError);
    expect(errorLine(err)).toBe("could not read the cadence config (ENOENT)");
    expect(errorLine(err)).not.toContain(dir);
  });

  it("prints a config error in full — it names category labels, never a patient value", async () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{ not json");

    await expect(
      runSeedCategoriesCli({ argv: ["--config", path], db, out: () => {} }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("recovery CLIs — the argument guards", () => {
  it("refuses a run with no --config, --out, or --timezone", async () => {
    await expect(runSeedCategoriesCli({ argv: [], db, out: () => {} })).rejects.toBeInstanceOf(
      UsageError,
    );
    await expect(leakReport(["--timezone", TZ])).rejects.toBeInstanceOf(UsageError);
    await expect(leakReport(["--out", join(dir, "leak-report.html")])).rejects.toBeInstanceOf(
      UsageError,
    );
  });

  it("refuses a timezone this runtime does not know", async () => {
    await expect(
      leakReport(["--out", join(dir, "leak-report.html"), "--timezone", "Mars/Olympus"]),
    ).rejects.toMatchObject({ name: "UsageError" });
  });

  // A SHAPE check passes 2026-13-01: the date then reads as NaN, which inverts every
  // comparison the pools make and silently pools everyone.
  it("refuses an --as-of that is not a real calendar date", async () => {
    for (const asOf of ["2026-13-01", "2026-01-32", "2026-04-31", "yesterday", "2026-06"]) {
      const err = await leakReport([
        "--out",
        join(dir, "leak-report.html"),
        "--timezone",
        TZ,
        "--as-of",
        asOf,
      ]).catch((thrown: unknown) => thrown);

      expect(err, asOf).toBeInstanceOf(UsageError);
      // The flag is named and what it expects is stated; the value is not echoed back.
      expect((err as Error).message, asOf).toContain("--as-of");
    }
  });

  it("accepts a real --as-of and anchors the report on it", async () => {
    const run = await leakReport([
      "--out",
      join(dir, "leak-report.html"),
      "--timezone",
      TZ,
      "--as-of",
      ymd(2026, 4, 30),
    ]);

    expect(run.data.asOf).toBe(ymd(2026, 4, 30));
  });

  it("refuses a --min-age-days that is not a whole number of days", async () => {
    for (const value of ["many", "-5", "7.5", " "]) {
      const err = await leakReport([
        "--out",
        join(dir, "leak-report.html"),
        "--timezone",
        TZ,
        "--min-age-days",
        value,
      ]).catch((thrown: unknown) => thrown);

      expect(err, value).toBeInstanceOf(UsageError);
      expect((err as Error).message, value).toContain("--min-age-days");
    }
  });
});
