import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { errorLine, runImportCli, UsageError } from "./import-cli.js";
import { csvFile, reportFile, ymd } from "./test-fixtures.js";
import * as schema from "../db/schema.js";
import { bootTestDb } from "../db/test-db.js";

let db: ReturnType<typeof drizzle>;
let dir: string;
let out: string[];

const TZ = "America/New_York";
/** R0's real Patient Export columns (aliases live in adapter-4d.ts). */
const PATIENT_HEADERS = ["Id", "First Name", "Last Name", "DOB", "Phone", "Email"];

/** Synthetic values distinctive enough that any leak into output is unmistakable. */
const LEAKY = {
  first: "Zzyzxine",
  last: "Quibbleworth",
  phone: "555-0177",
  email: "leaky@example.invalid",
};

const goodRow = (id: string) => [
  id,
  LEAKY.first,
  LEAKY.last,
  ymd(1970, 4, 12),
  LEAKY.phone,
  LEAKY.email,
];
const badRow = (id: string) => [
  id,
  LEAKY.first,
  LEAKY.last,
  "not-a-date",
  LEAKY.phone,
  LEAKY.email,
];

const writeCsv = (name: string, rows: readonly (readonly string[])[]): string => {
  const path = join(dir, name);
  writeFileSync(path, csvFile(PATIENT_HEADERS, rows));
  return path;
};

const run = (path: string) =>
  runImportCli({
    argv: ["--entity", "patients", "--file", path, "--timezone", TZ],
    db,
    out: (line) => out.push(line),
  });

// One PGlite boot per file (shared helper); explicit budget for cold CI runners.
beforeAll(async () => {
  db = await bootTestDb();
}, 60_000);

beforeEach(async () => {
  await db.delete(schema.stagedPatients);
  await db.delete(schema.imports);
  dir = mkdtempSync(join(tmpdir(), "medibun-import-"));
  out = [];
});

describe("import CLI — arguments", () => {
  it("refuses an unsupported entity, a missing file, or a missing timezone", async () => {
    const path = writeCsv("roster.csv", [goodRow("p-1")]);
    for (const argv of [
      ["--entity", "widgets", "--file", path, "--timezone", TZ],
      // 4D exports no inquiries (R0) — the CLI's entity list says so up front.
      ["--entity", "inquiries", "--file", path, "--timezone", TZ],
      ["--entity", "patients", "--timezone", TZ],
      ["--entity", "patients", "--file", path],
    ]) {
      await expect(runImportCli({ argv, db, out: (l) => out.push(l) })).rejects.toBeInstanceOf(
        UsageError,
      );
    }
  });

  it("reports an unreadable input without echoing the path it tried", async () => {
    const missing = join(dir, "handal-exports", "no-such-roster.csv");

    await expect(
      runImportCli({
        argv: ["--entity", "patients", "--file", missing, "--timezone", TZ],
        db,
        out: (l) => out.push(l),
      }),
    ).rejects.toMatchObject({ name: "UsageError" });
    try {
      await runImportCli({
        argv: ["--entity", "patients", "--file", missing, "--timezone", TZ],
        db,
        out: (l) => out.push(l),
      });
    } catch (err) {
      expect(errorLine(err)).toBe("could not read the input file (ENOENT)");
      expect(errorLine(err)).not.toContain(dir);
    }
  });
});

describe("import CLI — the rejects file", () => {
  it("writes it owner-only, even when a world-readable file is already there", async () => {
    const path = writeCsv("roster.csv", [goodRow("p-1"), badRow("p-2")]);
    const rejectsPath = `${path}.rejects.csv`;
    writeFileSync(rejectsPath, "stale\n");
    chmodSync(rejectsPath, 0o666);

    await run(path);

    expect(statSync(rejectsPath).mode & 0o777).toBe(0o600);
    const written = readFileSync(rejectsPath, "utf8");
    expect(written).not.toContain("stale");
    expect(written.split("\n")[0]).toBe("line,reason,raw");
    expect(written).toContain('"dob is not a calendar date"');
    expect(written).toContain(LEAKY.first);
  });

  it("removes the previous run's rejects when a re-import comes back clean", async () => {
    const path = writeCsv("roster.csv", [goodRow("p-1"), badRow("p-2")]);
    const rejectsPath = `${path}.rejects.csv`;
    await run(path);
    expect(existsSync(rejectsPath)).toBe(true);

    writeFileSync(path, csvFile(PATIENT_HEADERS, [goodRow("p-1"), goodRow("p-2")]));
    await run(path);

    // A ledger row saying "clean" must not sit beside last run's raw rows.
    expect(existsSync(rejectsPath)).toBe(false);
    const runs = await db.select().from(schema.imports);
    expect(runs.at(-1)?.rejectsUri).toBeNull();
  });

  it("defuses a rejected row a spreadsheet would execute on open", async () => {
    // A source row whose FIRST field opens with "=" makes the raw cell a live formula.
    const path = writeCsv("roster.csv", [
      ["=SUM(A1:A9)", LEAKY.first, LEAKY.last, "not-a-date", "", ""],
    ]);

    await run(path);

    const written = readFileSync(`${path}.rejects.csv`, "utf8");
    expect(written).toContain(`"'=SUM(A1:A9),${LEAKY.first}`);
    expect(written).not.toContain('"=SUM(A1:A9)');
  });
});

describe("import CLI — what reaches the operator", () => {
  it("prints counts, names, and ids — never a field value", async () => {
    const path = writeCsv("roster.csv", [goodRow("p-1"), badRow("p-2")]);

    const result = await run(path);

    const printed = out.join("\n");
    expect(printed).toContain("roster.csv");
    expect(printed).toContain("2 rows · 1 new · 0 reconciled · 1 rejected");
    expect(printed).toContain(result.importId);
    // Names the rejects file, never the directory it sits in (the rule the ledger
    // columns and the unreadable-input error already follow).
    expect(printed).toContain("roster.csv.rejects.csv written beside the input");
    expect(printed).not.toContain(dir);
    for (const value of Object.values(LEAKY)) {
      expect(printed).not.toContain(value);
    }
  });

  // R0 win (b): the exports print their own `Total X = N`, so a run reconciles against
  // the source with no side channel. Counts only — never a label, never a value.
  it("checks the run against the total the file declares about itself", async () => {
    const path = join(dir, "roster.csv");
    writeFileSync(
      path,
      reportFile([["Fakeman Plastic Surgery"], ["Patient Export"]], PATIENT_HEADERS, [
        goodRow("p-1"),
        badRow("p-2"),
        ["Total Patients = 2"],
      ]),
    );

    await run(path);

    const printed = out.join("\n");
    expect(printed).toContain("file declares 2 · staged 1 + rejected 1 ✓");
    expect(printed).toContain("3 report-layout rows skipped");
    for (const value of Object.values(LEAKY)) {
      expect(printed).not.toContain(value);
    }
  });

  it("warns on a mismatch in counts alone, and does not fail the run", async () => {
    const path = join(dir, "roster.csv");
    writeFileSync(path, reportFile([], PATIENT_HEADERS, [goodRow("p-1"), ["Total Patients = 9"]]));

    const result = await run(path);

    const printed = out.join("\n");
    expect(printed).toContain(
      "⚠ no declared total matches · closest 9 · staged 1 + rejected 0 (8 unaccounted)",
    );
    expect(result.rejectedCount).toBe(0);
  });

  // A file declares more than one total, and the largest is not the row count: a dollar
  // total reads as 152,340. Every declared number is checked, so the row total is found.
  it("checks the run against every total the file declares, not the largest", async () => {
    const path = join(dir, "roster.csv");
    writeFileSync(
      path,
      reportFile([], PATIENT_HEADERS, [
        goodRow("p-1"),
        badRow("p-2"),
        ["Total Collected = 152,340"],
        ["Total Patients = 2"],
      ]),
    );

    await run(path);

    expect(out.join("\n")).toContain("file declares 2 · staged 1 + rejected 1 ✓");
  });

  // Per-section subtotals with no grand total: the honest line names the closest number
  // as the closest, rather than claiming the file declared a row count it never did.
  it("says so plainly when no declared total matches the run", async () => {
    const path = join(dir, "roster.csv");
    writeFileSync(
      path,
      reportFile([], PATIENT_HEADERS, [
        goodRow("p-1"),
        ["Total Patients = 1"],
        goodRow("p-2"),
        ["Total Patients = 1"],
      ]),
    );

    await run(path);

    expect(out.join("\n")).toContain(
      "⚠ no declared total matches · closest 1 · staged 2 + rejected 0 (1 unaccounted)",
    );
  });

  // One entity delivered as several files is not supported: only the latest run per
  // export is read, so the second file supersedes every row of the first. The numbers
  // never show it, so the CLI says it where it happens. Basenames only.
  it("warns when the same entity arrives under a different file name", async () => {
    await run(writeCsv("roster-jan.csv", [goodRow("p-1")]));
    out = [];

    await run(writeCsv("roster-feb.csv", [goodRow("p-2")]));

    const printed = out.join("\n");
    expect(printed).toContain("the previous patients import read roster-jan.csv");
    expect(printed).toContain("this one reads roster-feb.csv");
    expect(printed).toContain("one full-range file per entity");
    expect(printed).not.toContain(dir);
    for (const value of Object.values(LEAKY)) {
      expect(printed).not.toContain(value);
    }
  });

  it("says nothing about split exports when the same file re-imports", async () => {
    const path = writeCsv("roster.csv", [goodRow("p-1")]);
    await run(path);
    out = [];

    await run(path);

    expect(out.join("\n")).not.toContain("full-range file");
  });

  it("prints no reconciliation line when the export declares no total", async () => {
    const path = writeCsv("roster.csv", [goodRow("p-1")]);

    await run(path);

    expect(out.join("\n")).not.toContain("file declares");
  });

  it("reduces a path-shaped input to its basename in both ledger columns", async () => {
    const path = writeCsv("roster.csv", [badRow("p-2")]);

    await run(path);

    const [ledger] = await db.select().from(schema.imports);
    expect(ledger?.fileName).toBe("roster.csv");
    expect(ledger?.rejectsUri).toBe("roster.csv.rejects.csv");
    expect(ledger?.fileName).not.toContain("/");
    expect(ledger?.rejectsUri).not.toContain("/");
  });

  it("scrubs a database failure down to its class and driver code", async () => {
    const path = writeCsv("roster.csv", [goodRow("p-1")]);
    await db.execute(sql`ALTER TABLE staged_patients DROP COLUMN email`);

    let thrown: unknown;
    try {
      await run(path);
    } catch (err) {
      thrown = err;
    } finally {
      await db.execute(sql`ALTER TABLE staged_patients ADD COLUMN email text`);
    }

    // The hazard this guards: drizzle's own message carries the bound parameters.
    expect((thrown as Error).message).toContain(LEAKY.email);
    const line = errorLine(thrown);
    expect(line).toBe("import failed: Error (42703)");
    for (const value of Object.values(LEAKY)) {
      expect(line).not.toContain(value);
    }
  });
});
