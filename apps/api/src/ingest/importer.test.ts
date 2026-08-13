import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createFourDAdapter } from "./adapter-4d.js";
import { createImportService, type ImportService } from "./importer.js";
import { csvFile, ymd, ymdhm } from "./test-fixtures.js";
import * as schema from "../db/schema.js";
import { bootTestDb } from "../db/test-db.js";

let db: ReturnType<typeof drizzle>;
let importer: ImportService;

const adapter = createFourDAdapter("America/New_York");

const PATIENT_HEADERS = ["patient_id", "first_name", "last_name", "dob", "phone", "email"];
const APPOINTMENT_HEADERS = [
  "appointment_id",
  "patient_id",
  "start_datetime",
  "status",
  "service_category",
  "provider",
];

const roster = (rows: readonly (readonly string[])[]): string => csvFile(PATIENT_HEADERS, rows);
const patientRow = (id: string, first: string, birth: string) => [
  id,
  first,
  "Fakeman",
  birth,
  "555-0100",
  `${id}@example.invalid`,
];

const runPatients = (content: string, rejectsUri?: string) =>
  importer.runImport({
    adapter,
    entity: "patients",
    fileName: "roster.csv",
    content,
    ...(rejectsUri === undefined ? {} : { rejectsUri }),
  });

// One PGlite boot per file (shared helper); explicit budget for cold CI runners.
beforeAll(async () => {
  db = await bootTestDb();
}, 60_000);

beforeEach(async () => {
  await db.delete(schema.stagedPatients);
  await db.delete(schema.stagedAppointments);
  await db.delete(schema.imports);
  importer = createImportService({ db });
});

describe("import service — the run ledger", () => {
  it("records the file hash, entity, and reconciling counts", async () => {
    const content = roster([
      patientRow("p-1", "Testerly", ymd(1970, 4, 12)),
      patientRow("p-2", "Otherly", ymd(1971, 5, 13)),
    ]);

    const summary = await runPatients(content);

    expect(summary).toMatchObject({
      rowCount: 2,
      stagedCount: 2,
      insertedCount: 2,
      updatedCount: 0,
      rejectedCount: 0,
      rejects: [],
    });
    const [run] = await db.select().from(schema.imports);
    expect(run).toMatchObject({
      id: summary.importId,
      sourceSystem: "4d",
      entity: "patients",
      fileName: "roster.csv",
      fileHash: createHash("sha256").update(content).digest("hex"),
      rowCount: 2,
      stagedCount: 2,
      rejectedCount: 0,
      rejectsUri: null,
    });
  });

  it("stamps every staged row with the run that wrote it", async () => {
    const summary = await runPatients(roster([patientRow("p-1", "Testerly", ymd(1970, 4, 12))]));

    const [row] = await db.select().from(schema.stagedPatients);
    expect(row).toMatchObject({
      sourceSystem: "4d",
      sourceIdentity: "p-1",
      importId: summary.importId,
      firstName: "Testerly",
      lastName: "Fakeman",
      dob: ymd(1970, 4, 12),
      phone: "555-0100",
      email: "p-1@example.invalid",
      medplumPatientId: null,
    });
  });

  it("appends a run row even when the same export re-imports unchanged", async () => {
    const content = roster([patientRow("p-1", "Testerly", ymd(1970, 4, 12))]);

    const first = await runPatients(content);
    const second = await runPatients(content);

    const runs = await db.select().from(schema.imports);
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((r) => r.fileHash))).toEqual(new Set([runs[0]!.fileHash]));
    expect(second.importId).not.toBe(first.importId);
  });

  it("records the rejects file by name only, and only when the run produced rejects", async () => {
    const clean = await runPatients(
      roster([patientRow("p-1", "Testerly", ymd(1970, 4, 12))]),
      "/home/someone/handal-exports/roster.csv.rejects.csv",
    );
    const dirty = await runPatients(
      roster([patientRow("p-2", "Testerly", "not-a-date")]),
      "/home/someone/handal-exports/roster.csv.rejects.csv",
    );

    const runs = await db.select().from(schema.imports);
    expect(runs.find((r) => r.id === clean.importId)?.rejectsUri).toBeNull();
    // The directory chain a human chose can itself name a patient — basename only.
    expect(runs.find((r) => r.id === dirty.importId)?.rejectsUri).toBe("roster.csv.rejects.csv");
  });

  it("stores a path-shaped file name as its basename", async () => {
    const run = await runPatients(roster([patientRow("p-1", "Testerly", ymd(1970, 4, 12))]));
    await importer.runImport({
      adapter,
      entity: "patients",
      fileName: "/home/someone/handal-exports/roster.csv",
      content: roster([patientRow("p-9", "Testerly", ymd(1970, 4, 12))]),
    });

    const runs = await db.select().from(schema.imports);
    expect(runs.map((r) => r.fileName)).toEqual(["roster.csv", "roster.csv"]);
    expect(run.importId).toBeDefined();
  });
});

describe("import service — idempotency", () => {
  it("re-importing the same export leaves one row per source identity", async () => {
    const content = roster([
      patientRow("p-1", "Testerly", ymd(1970, 4, 12)),
      patientRow("p-2", "Otherly", ymd(1971, 5, 13)),
    ]);

    await runPatients(content);
    const second = await runPatients(content);

    const rows = await db.select().from(schema.stagedPatients);
    expect(rows).toHaveLength(2);
    expect(second).toMatchObject({ stagedCount: 2, insertedCount: 0, updatedCount: 2 });
  });

  it("reconciles changed values onto the existing row and re-stamps it", async () => {
    const first = await runPatients(roster([patientRow("p-1", "Testerly", ymd(1970, 4, 12))]));
    const [before] = await db.select().from(schema.stagedPatients);

    const second = await runPatients(
      roster([["p-1", "Renamed", "Fakeman", ymd(1970, 4, 12), "555-0199", ""]]),
    );
    const [after] = await db.select().from(schema.stagedPatients);

    expect(after!.id).toBe(before!.id);
    expect(after!.createdAt).toEqual(before!.createdAt);
    expect(after!.firstName).toBe("Renamed");
    expect(after!.phone).toBe("555-0199");
    // A value cleared in the newer export clears in staging — the export supersedes.
    expect(after!.email).toBeNull();
    expect(after!.importId).toBe(second.importId);
    expect(after!.importId).not.toBe(first.importId);
    expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(before!.updatedAt.getTime());
  });

  it("keeps the same source identity from another source system distinct", async () => {
    const run = await runPatients(roster([patientRow("p-1", "Testerly", ymd(1970, 4, 12))]));
    await db.insert(schema.stagedPatients).values({
      sourceSystem: "legacy-import",
      sourceIdentity: "p-1",
      importId: run.importId,
      firstName: "Elsewhere",
    });

    await runPatients(roster([["p-1", "Renamed", "Fakeman", ymd(1970, 4, 12), "555-0100", ""]]));

    const rows = await db.select().from(schema.stagedPatients);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.sourceSystem === "legacy-import")?.firstName).toBe("Elsewhere");
    expect(rows.find((r) => r.sourceSystem === "4d")?.firstName).toBe("Renamed");
  });
});

describe("import service — rejects", () => {
  it("stages the good rows and counts the bad ones", async () => {
    const summary = await runPatients(
      roster([
        patientRow("p-1", "Testerly", ymd(1970, 4, 12)),
        patientRow("p-2", "Otherly", "not-a-date"),
        patientRow("p-3", "Thirdly", ymd(1972, 6, 14)),
      ]),
    );

    expect(summary).toMatchObject({ rowCount: 3, stagedCount: 2, rejectedCount: 1 });
    expect(summary.rejects.map((r) => r.line)).toEqual([3]);
    const rows = await db.select().from(schema.stagedPatients);
    expect(rows.map((r) => r.sourceIdentity).sort()).toEqual(["p-1", "p-3"]);
  });

  it("never writes raw rejected row content to the database", async () => {
    const summary = await runPatients(
      roster([["p-2", "Zzyzxine", "Quibbleworth", "not-a-date", "555-0177", ""]]),
    );

    const [run] = await db.select().from(schema.imports);
    expect(JSON.stringify(run)).not.toContain("Zzyzxine");
    expect(await db.select().from(schema.stagedPatients)).toEqual([]);
    // The raw row survives only in the summary the CLI writes to the rejects file.
    expect(summary.rejects[0]?.raw).toContain("Zzyzxine");
  });

  it("records a run with zero staged rows rather than failing", async () => {
    const summary = await runPatients(roster([patientRow("p-1", "Testerly", "not-a-date")]));

    expect(summary).toMatchObject({ rowCount: 1, stagedCount: 0, rejectedCount: 1 });
    expect(await db.select().from(schema.imports)).toHaveLength(1);
  });
});

describe("import service — other entities", () => {
  it("stages appointments with the practice-local start time resolved", async () => {
    const summary = await importer.runImport({
      adapter,
      entity: "appointments",
      fileName: "appointments.csv",
      content: csvFile(APPOINTMENT_HEADERS, [
        ["a-1", "p-1", ymdhm(2026, 7, 15, 14, 30), "Completed", "Injectables", "Dr Fakeman"],
      ]),
    });

    expect(summary).toMatchObject({ rowCount: 1, stagedCount: 1 });
    const [row] = await db
      .select()
      .from(schema.stagedAppointments)
      .where(eq(schema.stagedAppointments.sourceIdentity, "a-1"));
    expect(row).toMatchObject({
      patientSourceIdentity: "p-1",
      statusRaw: "Completed",
      serviceCategoryRaw: "Injectables",
      providerRaw: "Dr Fakeman",
      importId: summary.importId,
    });
    expect(row!.startAt.toISOString()).toBe("2026-07-15T18:30:00.000Z");
  });
});
