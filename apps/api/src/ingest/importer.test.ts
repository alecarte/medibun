import { createHash } from "node:crypto";

import type { drizzle } from "drizzle-orm/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createFourDAdapter } from "./adapter-4d.js";
import {
  createImportService,
  currentImportIds,
  HeterogeneousBatchError,
  type ImportService,
} from "./importer.js";
import { csvFile, ymd, ymdhm } from "./test-fixtures.js";
import type { SourceAdapter, StagedPatientRow } from "./types.js";
import * as schema from "../db/schema.js";
import { bootTestDb } from "../db/test-db.js";

let db: ReturnType<typeof drizzle>;
let importer: ImportService;

const adapter = createFourDAdapter("America/New_York");

// R0's real 4D header names (adapter-4d.ts owns the aliases); the report furniture
// those exports also carry is exercised in adapter-4d.test.ts, not here.
const PATIENT_HEADERS = ["Id", "First Name", "Last Name", "DOB", "Phone", "Email"];
const APPOINTMENT_HEADERS = [
  "Patient Id",
  "Patient",
  "Date/Time",
  "Status",
  "Appt Type",
  "Provider",
];
const CONSULT_HEADERS = [
  "Consult Date",
  "Patient",
  "Quote Number",
  "Provider",
  "Procedure",
  "Quote Amount",
  "Booked",
  "Completed",
];
const TRANSACTION_HEADERS = ["DOS", "Id", "Category", "Amount"];

const roster = (rows: readonly (readonly string[])[]): string => csvFile(PATIENT_HEADERS, rows);
const patientRow = (id: string, first: string, birth: string) => [
  id,
  first,
  "Fakeman",
  birth,
  "555-0100",
  `${id}@example.invalid`,
];

/** An adapter that stages rows built by hand: the only way to hand the importer a batch
 *  whose rows disagree about which columns they carry, which no CSV adapter can produce
 *  (`buildRow` sets every mapped column on every row) and which the importer refuses. */
const batchAdapter = (rows: readonly Partial<StagedPatientRow>[]): SourceAdapter => ({
  sourceSystem: "4d",
  entities: ["patients"],
  parse: (() => ({
    rows,
    rejects: [],
    layoutRowCount: 0,
    declaredTotals: [],
  })) as SourceAdapter["parse"],
});

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
  await db.delete(schema.stagedConsults);
  await db.delete(schema.stagedTransactions);
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

  // The refresh set is the batch's UNIFORM key set: every mapped column on every row.
  it("refreshes every column the batch fills, on every row of it", async () => {
    await runPatients(
      roster([
        patientRow("p-1", "Testerly", ymd(1970, 4, 12)),
        patientRow("p-2", "Otherly", ymd(1971, 5, 13)),
      ]),
    );

    await importer.runImport({
      adapter: batchAdapter([
        { sourceIdentity: "p-1", firstName: "Renamed", email: "one@example.invalid" },
        { sourceIdentity: "p-2", firstName: "Renamed", email: "two@example.invalid" },
      ]),
      entity: "patients",
      fileName: "roster.csv",
      content: "hand-built rows",
    });

    const rows = await db.select().from(schema.stagedPatients);
    expect(rows.map((r) => [r.sourceIdentity, r.firstName, r.email]).sort()).toEqual([
      ["p-1", "Renamed", "one@example.invalid"],
      ["p-2", "Renamed", "two@example.invalid"],
    ]);
  });

  // The contract that makes the rule above safe. An upsert's `set` clause applies to the
  // whole statement, so a key one row omits would refresh from `excluded` NULL and CLEAR
  // that row's existing value — behind a ledger line saying the run reconciled. Adapter
  // rows are homogeneous by construction; a batch that is not is a bug, and it stops here.
  it("refuses a batch whose rows do not all carry the same columns", async () => {
    await runPatients(roster([patientRow("p-1", "Testerly", ymd(1970, 4, 12))]));

    const run = importer.runImport({
      adapter: batchAdapter([
        { sourceIdentity: "p-1", firstName: "Renamed", email: "one@example.invalid" },
        { sourceIdentity: "p-2", firstName: "Renamed" },
      ]),
      entity: "patients",
      fileName: "roster.csv",
      content: "hand-built rows",
    });

    await expect(run).rejects.toBeInstanceOf(HeterogeneousBatchError);
    // The message names the entity and the differing COLUMN — our own vocabulary, never
    // a row value — and nothing about the run reaches the ledger.
    await expect(run).rejects.toThrow(/patients.*email/);
    expect(await db.select().from(schema.imports)).toHaveLength(1);
  });

  // The mirror of the rule above: a column NO adapter fills is not the export's to clear.
  it("leaves a column the adapter never fills alone", async () => {
    await runPatients(roster([patientRow("p-1", "Testerly", ymd(1970, 4, 12))]));
    await db.update(schema.stagedPatients).set({ medplumPatientId: "Patient/abc" });

    await runPatients(roster([["p-1", "Renamed", "Fakeman", ymd(1970, 4, 12), "555-0100", ""]]));

    const [row] = await db.select().from(schema.stagedPatients);
    expect(row).toMatchObject({ firstName: "Renamed", medplumPatientId: "Patient/abc" });
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

describe("import service — which run the readers count", () => {
  // A run that staged NOTHING cannot represent a full export. Taken as the filtering run
  // it would supersede every good row before it in one stroke — a file rejected wholesale
  // on a header change would read as a practice with no data at all.
  it("never lets a run that staged nothing become the counted one", async () => {
    const good = await runPatients(roster([patientRow("p-1", "Testerly", ymd(1970, 4, 12))]));
    const allRejected = await runPatients(roster([patientRow("p-1", "Testerly", "not-a-date")]));

    expect(allRejected.stagedCount).toBe(0);
    const current = await currentImportIds(db);
    expect([...current]).toEqual([good.importId]);
    const [row] = await db.select().from(schema.stagedPatients);
    expect(current.has(row!.importId)).toBe(true);
  });

  // Two runs stamped in the same instant have to fold the same way on every read, or a
  // report and the seed it was generated beside would count different rows.
  it("breaks a createdAt tie by id, so every read folds the same way", async () => {
    const at = new Date("2026-08-15T00:00:00.000Z");
    const run = (id: string, fileName: string) => ({
      id,
      sourceSystem: "4d" as const,
      entity: "patients" as const,
      fileName,
      fileHash: "hash",
      rowCount: 1,
      stagedCount: 1,
      rejectedCount: 0,
      createdAt: at,
    });
    await db
      .insert(schema.imports)
      .values([
        run("00000000-0000-4000-8000-000000000002", "second.csv"),
        run("00000000-0000-4000-8000-000000000001", "first.csv"),
      ]);

    expect([...(await currentImportIds(db))]).toEqual(["00000000-0000-4000-8000-000000000002"]);
  });
});

describe("import service — other entities", () => {
  it("stages appointments with the practice-local start time resolved", async () => {
    const summary = await importer.runImport({
      adapter,
      entity: "appointments",
      fileName: "appointments.csv",
      content: csvFile(APPOINTMENT_HEADERS, [
        ["p-1", "Testerly Fakeman", ymdhm(2026, 7, 15, 14, 30), "Completed", "Injectables", "Dr F"],
      ]),
    });

    expect(summary).toMatchObject({ rowCount: 1, stagedCount: 1 });
    const [row] = await db.select().from(schema.stagedAppointments);
    expect(row).toMatchObject({
      patientSourceIdentity: "p-1",
      patientName: "Testerly Fakeman",
      statusRaw: "Completed",
      serviceCategoryRaw: "Injectables",
      providerRaw: "Dr F",
      importId: summary.importId,
    });
    expect(row!.startAt.toISOString()).toBe("2026-07-15T18:30:00.000Z");
    // This export carries no row id, so the adapter derived one (DATA_MODEL.md).
    expect(row!.sourceIdentity).toMatch(/^[0-9a-f]{64}$/);
  });

  // A derived identity has to survive a re-import, or every run would duplicate the
  // whole appointment history instead of reconciling it.
  it("re-imports a derived-identity export onto the same rows", async () => {
    const content = csvFile(APPOINTMENT_HEADERS, [
      ["", "Testerly Fakeman", ymdhm(2026, 7, 15, 14, 30), "", "Injectables", "Dr F"],
      ["", "Otherly Fakeman", ymdhm(2026, 7, 15, 15, 30), "", "Injectables", "Dr F"],
    ]);
    const run = (body: string) =>
      importer.runImport({ adapter, entity: "appointments", fileName: "appts.csv", content: body });

    const first = await run(content);
    const second = await run(content);

    expect(first).toMatchObject({ insertedCount: 2, updatedCount: 0 });
    expect(second).toMatchObject({ insertedCount: 0, updatedCount: 2 });
    expect(await db.select().from(schema.stagedAppointments)).toHaveLength(2);
  });

  // R0: the real appointment export has no patient id and no status column, so both
  // columns must accept null and the roster join keys must survive the round trip.
  it("stages an appointment that carries roster join keys instead of a patient id", async () => {
    await importer.runImport({
      adapter,
      entity: "appointments",
      fileName: "appointments.csv",
      content: csvFile(
        ["Date/Time", "Patient", "DOB", "Phone", "Appt Type"],
        [
          [
            ymdhm(2026, 7, 16, 9, 0),
            "Testerly Fakeman",
            ymd(1970, 4, 12),
            "555-0100",
            "Injectables",
          ],
        ],
      ),
    });

    const [row] = await db.select().from(schema.stagedAppointments);
    expect(row).toMatchObject({
      patientSourceIdentity: null,
      statusRaw: null,
      patientName: "Testerly Fakeman",
      dob: ymd(1970, 4, 12),
      phone: "555-0100",
    });
  });

  it("stages consults by name and date with the quoted dollars as cents", async () => {
    const summary = await importer.runImport({
      adapter,
      entity: "consults",
      fileName: "conversion.csv",
      content: csvFile(CONSULT_HEADERS, [
        [
          ymd(2026, 7, 15),
          "Testerly Fakeman",
          "q-1",
          "Dr Fakeman",
          "Surgical",
          "7500.00",
          "No",
          "Yes",
        ],
      ]),
    });

    const [row] = await db.select().from(schema.stagedConsults);
    expect(row).toMatchObject({
      sourceIdentity: "q-1",
      patientSourceIdentity: null,
      patientName: "Testerly Fakeman",
      consultDate: ymd(2026, 7, 15),
      serviceCategoryRaw: "Surgical",
      outcomeRaw: null,
      providerRaw: "Dr Fakeman",
      quoteAmountCents: 750_000,
      bookedRaw: "No",
      completedRaw: "Yes",
      importId: summary.importId,
    });
  });

  it("stages transactions, keeping a refund negative and reconciling a re-import", async () => {
    const content = csvFile(TRANSACTION_HEADERS, [
      [ymd(2026, 7, 15), "p-1", "Injectables", "1234.56"],
      [ymd(2026, 7, 16), "", "Garments", "-89.00"],
    ]);
    const runTransactions = (body: string) =>
      importer.runImport({
        adapter,
        entity: "transactions",
        fileName: "revenue.csv",
        content: body,
      });

    const first = await runTransactions(content);
    const second = await runTransactions(content);

    expect(first).toMatchObject({ stagedCount: 2, insertedCount: 2, updatedCount: 0 });
    // Derived identities are stable across runs — a re-import reconciles, never doubles.
    expect(second).toMatchObject({ stagedCount: 2, insertedCount: 0, updatedCount: 2 });
    const staged = await db.select().from(schema.stagedTransactions);
    expect(staged).toHaveLength(2);
    expect(staged.find((r) => r.serviceCategoryRaw === "Injectables")).toMatchObject({
      patientSourceIdentity: "p-1",
      transactionDate: ymd(2026, 7, 15),
      amountCents: 123_456,
      importId: second.importId,
    });
    // A refund is negative money, not a missing row; a non-patient row keeps a null id.
    expect(staged.find((r) => r.serviceCategoryRaw === "Garments")).toMatchObject({
      patientSourceIdentity: null,
      amountCents: -8_900,
    });
  });
});
