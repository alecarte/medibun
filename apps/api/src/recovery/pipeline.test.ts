import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { runLeakReportCli, runSeedCategoriesCli } from "./cli.js";
import { RECOVERED_DEFINITION } from "./leak-report.js";
import { createFourDAdapter } from "../ingest/adapter-4d.js";
import { createImportService } from "../ingest/importer.js";
import { csvFile, prose, reportFile, ymd, ymdhm } from "../ingest/test-fixtures.js";
import * as schema from "../db/schema.js";
import { bootTestDb } from "../db/test-db.js";
import type { StagedEntity } from "../db/schema.js";

/**
 * The R2c round trip against a real schema: import four synthetic 4D exports, seed the
 * categories from a synthetic cadence config, and generate the Leak Report — then check
 * the numbers AND check that not one fixture identity reached the document. The report is
 * the artifact a practice receives, so "aggregates only" is a property worth a test, not
 * a comment.
 */

const TZ = "America/New_York";
const AS_OF = ymd(2026, 6, 1);

/** Synthetic values distinctive enough that any leak into the report is unmistakable
 *  (same posture as the import CLI suite). */
const SURNAME = "Quibbleworth";
const ROSTER = [
  {
    id: "p-1",
    first: "Zzyzxine",
    dob: ymd(1970, 4, 12),
    phone: "555-0100",
    email: "p1@example.invalid",
  },
  { id: "p-2", first: "Vorbling", dob: ymd(1971, 5, 13), phone: "555-0101", email: "" },
  { id: "p-3", first: "Thrapple", dob: ymd(1972, 6, 14), phone: "", email: "p3@example.invalid" },
  {
    id: "p-4",
    first: "Fennimore",
    dob: ymd(1973, 7, 15),
    phone: "555-0103",
    email: "p4@example.invalid",
  },
  {
    id: "p-5",
    first: "Grimsby",
    dob: ymd(1974, 8, 16),
    phone: "555-0104",
    email: "p5@example.invalid",
  },
  // Two patients, one name — the consult report's name-only join cannot tell them apart.
  {
    id: "p-6",
    first: "Halloway",
    dob: ymd(1975, 9, 17),
    phone: "555-0105",
    email: "p6@example.invalid",
  },
  {
    id: "p-7",
    first: "Halloway",
    dob: ymd(1976, 10, 18),
    phone: "555-0106",
    email: "p7@example.invalid",
  },
] as const;

const INJECTABLES = "Example Injectables";
/** A label carrying markup characters: the report must escape, not render, it. */
const PEELS = "Peels <& Masks>";
const RETAIL = "Example Retail";

const PATIENT_HEADERS = ["Id", "First Name", "Last Name", "DOB", "Phone", "Email"];
const APPOINTMENT_HEADERS = ["Date/Time", "Provider", "Patient", "DOB", "Phone", "Appt Type"];
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

const patients = csvFile(
  PATIENT_HEADERS,
  ROSTER.map((row) => [row.id, row.first, SURNAME, row.dob, row.phone, row.email]),
);

const appointments = csvFile(APPOINTMENT_HEADERS, [
  // Future: excludes Grimsby from the dormant pool, joined on name + DOB + phone.
  [
    ymdhm(2026, 7, 15, 10, 0),
    "Dr Fakeman",
    `${SURNAME}, Grimsby`,
    ymd(1974, 8, 16),
    "(555) 010-4",
    "Follow-up",
  ],
  // Past: resolves, but excludes nobody.
  [
    ymdhm(2025, 11, 1, 9, 0),
    "Dr Fakeman",
    `Vorbling ${SURNAME}`,
    ymd(1971, 5, 13),
    "555-0101",
    "Follow-up",
  ],
  // No DOB and no phone: the triple join cannot resolve it, and the report says so.
  // Its evening wall time is also the export's horizon: 21:30 in a practice four hours
  // behind UTC is the NEXT UTC day, so a report that renders in UTC prints it a day late.
  [ymdhm(2026, 8, 1, 21, 30), "Dr Fakeman", `Jandrell ${SURNAME}`, "", "", "Consult"],
]);

const consults = csvFile(CONSULT_HEADERS, [
  [
    ymd(2026, 1, 5),
    `Vorbling ${SURNAME}`,
    "q-1",
    "Dr Fakeman",
    "Example Surgery",
    "8000.00",
    "No",
    "Yes",
  ],
  [
    ymd(2026, 1, 6),
    `Thrapple ${SURNAME}`,
    "q-2",
    "Dr Fakeman",
    "Example Surgery",
    "5000.00",
    "Yes",
    "Yes",
  ],
  [
    ymd(2026, 1, 7),
    `Grimsby ${SURNAME}`,
    "q-3",
    "Dr Fakeman",
    "Example Surgery",
    "4000.00",
    "No",
    "Yes",
  ],
  [
    ymd(2026, 5, 25),
    `Fennimore ${SURNAME}`,
    "q-4",
    "Dr Fakeman",
    "Example Surgery",
    "3000.00",
    "No",
    "Yes",
  ],
  [ymd(2026, 1, 8), `Ixworth ${SURNAME}`, "q-5", "Dr Fakeman", "Example Surgery", "", "No", "Yes"],
  [
    ymd(2026, 1, 9),
    `Zzyzxine ${SURNAME}`,
    "q-6",
    "Dr Fakeman",
    "Example Surgery",
    "9000.00",
    "maybe",
    "Yes",
  ],
  [
    ymd(2026, 1, 9),
    `Halloway ${SURNAME}`,
    "q-7",
    "Dr Fakeman",
    "Example Surgery",
    "6000.00",
    "No",
    "Yes",
  ],
]);

/** The revenue export, in 4D's real report layout: preamble, then a declared total. */
const transactions = reportFile(
  [["Example Plastic Surgery"], ["Revenue by Staff Incl. Procedure Prepayments"], ["Range"]],
  TRANSACTION_HEADERS,
  [
    [AS_OF, "p-1", INJECTABLES, "500.00"],
    [ymd(2025, 1, 10), "p-2", INJECTABLES, "300.00"],
    [ymd(2025, 1, 10), "p-2", INJECTABLES, "100.00"],
    [ymd(2025, 6, 10), "p-3", INJECTABLES, "600.00"],
    [ymd(2025, 2, 10), "p-5", INJECTABLES, "500.00"],
    [ymd(2025, 3, 5), "p-4", PEELS, "200.00"],
    [ymd(2026, 5, 20), "p-4", RETAIL, "50.00"],
    ["Total Rows = 7"],
  ],
);

const CADENCE = JSON.stringify({
  categories: {
    [INJECTABLES]: { expectedReturnIntervalDays: 120 },
    [PEELS]: { expectedReturnIntervalDays: 90 },
    [RETAIL]: { expectedReturnIntervalDays: null },
    // Named by the operator but absent from revenue: it still lands, hand-set.
    "Example Surgery": { expectedReturnIntervalDays: 730, typicalTicketCents: 850_000 },
  },
});

let db: ReturnType<typeof drizzle>;
let dir: string;
const out: string[] = [];
let html: string;
/** The document as a reader reads it (test-fixtures.ts: markup stripped, whitespace
 *  collapsed), so assertions do not depend on where the template happens to wrap. */
let reportProse: string;

beforeAll(async () => {
  db = await bootTestDb();
  dir = mkdtempSync(join(tmpdir(), "medibun-leak-"));
  const importer = createImportService({ db });
  const adapter = createFourDAdapter(TZ);
  const files: readonly [StagedEntity, string][] = [
    ["patients", patients],
    ["appointments", appointments],
    ["consults", consults],
    ["transactions", transactions],
  ];
  for (const [entity, content] of files) {
    await importer.runImport({ adapter, entity, fileName: `${entity}.csv`, content });
  }

  const configPath = join(dir, "cadence.json");
  writeFileSync(configPath, CADENCE);
  // Twice: the seed is idempotent, and the report must not depend on how often it ran.
  await runSeedCategoriesCli({ argv: ["--config", configPath], db, out: () => {} });
  await runSeedCategoriesCli({ argv: ["--config", configPath], db, out: (line) => out.push(line) });

  const run = await runLeakReportCli({
    argv: [
      "--out",
      join(dir, "leak-report.html"),
      "--practice",
      "Example Plastic Surgery",
      "--timezone",
      TZ,
    ],
    db,
    out: (line) => out.push(line),
  });
  html = readFileSync(run.outPath, "utf8");
  reportProse = prose(html);
}, 60_000);

describe("category seeding", () => {
  it("writes one row per category, revenue-averaged, and re-runs onto the same rows", async () => {
    const rows = await db.select().from(schema.serviceCategories);

    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.code === "example-injectables")).toMatchObject({
      display: INJECTABLES,
      // Four visits — 500 + (300 + 100) + 600 + 500 — averaging $500.
      typicalTicketCents: 50_000,
      ticketBasis: "revenue-average",
      expectedReturnIntervalDays: 120,
    });
    expect(rows.find((r) => r.code === "peels-masks")).toMatchObject({
      display: PEELS,
      typicalTicketCents: 20_000,
      expectedReturnIntervalDays: 90,
    });
    expect(rows.find((r) => r.code === "example-retail")).toMatchObject({
      expectedReturnIntervalDays: null,
    });
    expect(rows.find((r) => r.code === "example-surgery")).toMatchObject({
      typicalTicketCents: 850_000,
      ticketBasis: "hand-set",
      expectedReturnIntervalDays: 730,
    });
  });
});

describe("the leak report", () => {
  it("counts the dormant pool from the revenue rows, less the patient booked ahead", () => {
    expect(reportProse).toContain("3 opportunities across 3 patients");
    // 2 dormant injectables patients at $500, plus 1 dormant peels patient at $200.
    expect(reportProse).toContain("$1,200");
    expect(reportProse).toContain(INJECTABLES);
    expect(reportProse).toContain("1 otherwise-dormant patient was left out of the pool");
  });

  it("counts the unconverted consults and every degradation beside them", () => {
    // Booked, too recent, returned, ambiguous, and uninterpretable are each held back.
    expect(reportProse).toContain("2 consults quoted and not booked");
    expect(reportProse).toContain("$8,000");
    expect(reportProse).toContain("1 consult removed");
    expect(reportProse).toContain("1 consult held back as ambiguous");
    expect(reportProse).toContain("1 consult whose booked column carried no answer");
    expect(reportProse).toContain("1 consult kept in the pool whose name matched no roster record");
    expect(reportProse).toContain("1 consult read as booked and 1 consult as too recent");
  });

  it("states one headline figure — both pools", () => {
    expect(reportProse).toContain("$9,200");
  });

  it("reports the appointment join honestly rather than hiding the misses", () => {
    expect(reportProse).toContain("2 of 3 rows matched (67%)");
  });

  // Staged instants are timestamptz; the report dates them in the PRACTICE's zone. The
  // 21:30 appointment falls on the next UTC day, and printing that would tell a practice
  // its export covers a day it does not.
  it("dates the appointment window in the practice's zone, not UTC", () => {
    expect(reportProse).toContain(`${ymd(2025, 11, 1)} to ${ymd(2026, 8, 1)}`);
    expect(reportProse).not.toContain(ymd(2026, 8, 2));
  });

  it("quotes the contractual definition of recovered, verbatim", () => {
    expect(html).toContain(RECOVERED_DEFINITION);
  });

  it("escapes a category label that carries markup", () => {
    expect(html).toContain("Peels &lt;&amp; Masks&gt;");
    expect(html).not.toContain(PEELS);
  });

  it("leaks no patient identity into the document or the terminal", () => {
    const identities = [
      SURNAME,
      ...ROSTER.flatMap((row) => [row.id, row.first, row.dob, row.phone, row.email]),
      "Ixworth",
      "Jandrell",
      "q-1",
    ].filter((value) => value !== "");

    for (const value of identities) {
      expect(html).not.toContain(value);
      expect(out.join("\n")).not.toContain(value);
    }
  });

  it("writes the report where it was told, owner-readable only", () => {
    expect(statSync(join(dir, "leak-report.html")).mode & 0o777).toBe(0o600);
    // The terminal gets the basename, never the directory a practice's file sits in.
    expect(out.join("\n")).toContain(basename(join(dir, "leak-report.html")));
    expect(out.join("\n")).not.toContain(dir);
  });

  it("states what the latest import superseded, none of it here", () => {
    expect(reportProse).toContain("0 revenue rows superseded by a later import");
  });

  it("replaces a pre-existing world-readable report instead of writing into it", async () => {
    // writeFileSync's mode applies on CREATE only, so a file already sitting there would
    // otherwise keep its looser permissions — holding a confidential report at 0644 for
    // as long as it takes the next line to run. The previous file is removed first.
    const stalePath = join(dir, "stale-report.html");
    writeFileSync(stalePath, "stale");
    chmodSync(stalePath, 0o644);

    await runLeakReportCli({ argv: ["--out", stalePath, "--timezone", TZ], db, out: () => {} });

    expect(statSync(stalePath).mode & 0o777).toBe(0o600);
    expect(readFileSync(stalePath, "utf8")).not.toContain("stale");
  });
});

/**
 * A corrected export, which is what makes the "read only the latest import" rule load
 * bearing. 4D voids a revenue line and re-prints it at another amount: the correction
 * stages under a NEW identity (the amount is hashed into the derived one) while the old
 * row stays behind, because imports never delete. Read together, the two net into one
 * visit and inflate the ticket, the expected value, and the headline above it.
 */
describe("the leak report — a corrected re-import", () => {
  const VISIT_DATE = ymd(2025, 1, 10);
  let corrected: ReturnType<typeof drizzle>;
  let run: Awaited<ReturnType<typeof runLeakReportCli>>;

  beforeAll(async () => {
    corrected = await bootTestDb();
    const importer = createImportService({ db: corrected });
    const adapter = createFourDAdapter(TZ);
    const revenue = (rows: readonly (readonly string[])[]) => csvFile(TRANSACTION_HEADERS, rows);
    const runImport = (content: string) =>
      importer.runImport({ adapter, entity: "transactions", fileName: "revenue.csv", content });

    await runImport(
      revenue([
        [VISIT_DATE, "p-1", INJECTABLES, "500.00"],
        [VISIT_DATE, "p-8", INJECTABLES, "300.00"],
      ]),
    );
    // The next export prices p-1's line at $250 and no longer carries p-8's line at all.
    await runImport(revenue([[VISIT_DATE, "p-1", INJECTABLES, "250.00"]]));

    const configPath = join(dir, "corrected-cadence.json");
    writeFileSync(
      configPath,
      JSON.stringify({ categories: { [INJECTABLES]: { expectedReturnIntervalDays: 120 } } }),
    );
    await runSeedCategoriesCli({ argv: ["--config", configPath], db: corrected, out: () => {} });
    run = await runLeakReportCli({
      argv: ["--out", join(dir, "corrected.html"), "--timezone", TZ, "--as-of", AS_OF],
      db: corrected,
      out: () => {},
    });
  }, 60_000);

  it("keeps every staged row but tickets the category from the latest export alone", async () => {
    const staged = await corrected.select().from(schema.stagedTransactions);
    const categories = await corrected.select().from(schema.serviceCategories);

    expect(staged).toHaveLength(3);
    expect(categories.find((r) => r.code === "example-injectables")).toMatchObject({
      // $250, the corrected amount — not $525, the average of a netted $750 visit and a
      // visit the practice no longer has on its books.
      typicalTicketCents: 25_000,
      ticketBasis: "revenue-average",
    });
  });

  it("pools the one patient the latest export still anchors, at the corrected value", () => {
    expect(run.data.dormant).toMatchObject({
      opportunityCount: 1,
      patientCount: 1,
      expectedValueCents: 25_000,
    });
  });

  it("counts the superseded rows in the report rather than dropping them silently", () => {
    expect(run.data.superseded.transactions).toBe(2);
    expect(prose(readFileSync(run.outPath, "utf8"))).toContain(
      "2 revenue rows superseded by a later import",
    );
  });

  // The seed reads the same rule and had been the one reader making the exclusion in
  // silence (security review, LOW): what a terminal prints is the operator's only view of
  // it. Counts only — no label, no row content.
  it("states the exclusion at the terminal too, in counts alone", async () => {
    const lines: string[] = [];

    await runSeedCategoriesCli({
      argv: ["--config", join(dir, "corrected-cadence.json")],
      db: corrected,
      out: (line) => lines.push(line),
    });

    expect(lines.join("\n")).toContain(
      "2 revenue rows superseded by the latest import were excluded",
    );
  });
});

/**
 * Two re-imports that did not come back clean, and the two different things the report has
 * to do about them: a run that staged NOTHING must never become the run every reader
 * filters by, and a run that staged some rows and rejected others makes its superseded
 * count ambiguous — a rejected row never reached staging, so it is indistinguishable from
 * a row the practice system no longer carries.
 */
describe("the leak report — re-imports that rejected rows", () => {
  const VISIT_DATE = ymd(2025, 1, 10);
  let rejected: ReturnType<typeof drizzle>;
  let run: Awaited<ReturnType<typeof runLeakReportCli>>;

  beforeAll(async () => {
    rejected = await bootTestDb();
    const importer = createImportService({ db: rejected });
    const adapter = createFourDAdapter(TZ);
    const runImport = (entity: StagedEntity, content: string) =>
      importer.runImport({ adapter, entity, fileName: `${entity}.csv`, content });
    const roster = (dob: string) =>
      csvFile(PATIENT_HEADERS, [
        ["p-1", "Zzyzxine", SURNAME, dob, "555-0100", "p1@example.invalid"],
      ]);

    // The roster: one good import, then a re-import in which EVERY row rejects.
    await runImport("patients", roster(ymd(1970, 4, 12)));
    const allBad = await runImport("patients", roster("not-a-date"));
    expect(allBad).toMatchObject({ stagedCount: 0, rejectedCount: 1 });

    // Revenue: two rows, then a corrected re-import that also carries one unreadable row.
    await runImport(
      "transactions",
      csvFile(TRANSACTION_HEADERS, [
        [VISIT_DATE, "p-1", INJECTABLES, "500.00"],
        [VISIT_DATE, "p-2", INJECTABLES, "300.00"],
      ]),
    );
    const partial = await runImport(
      "transactions",
      csvFile(TRANSACTION_HEADERS, [
        [VISIT_DATE, "p-1", INJECTABLES, "250.00"],
        [VISIT_DATE, "p-2", INJECTABLES, "n/a"],
      ]),
    );
    expect(partial).toMatchObject({ stagedCount: 1, rejectedCount: 1 });

    const configPath = join(dir, "rejected-cadence.json");
    writeFileSync(
      configPath,
      JSON.stringify({ categories: { [INJECTABLES]: { expectedReturnIntervalDays: 120 } } }),
    );
    await runSeedCategoriesCli({ argv: ["--config", configPath], db: rejected, out: () => {} });
    run = await runLeakReportCli({
      argv: ["--out", join(dir, "rejected.html"), "--timezone", TZ, "--as-of", AS_OF],
      db: rejected,
      out: () => {},
    });
  }, 60_000);

  it("keeps counting the rows the last COUNTED import staged", () => {
    // The all-reject run staged nothing, so it never became the filtering run: the roster
    // row is still current, and nothing about it reads as superseded.
    expect(run.data.staged.patients).toBe(1);
    expect(run.data.superseded.patients).toBe(0);
    expect(run.data.dormant.contactability.withEither).toBe(1);
  });

  it("caveats a superseded count the partial re-import may have reject-shadowed", () => {
    expect(run.data.superseded.transactions).toBe(2);
    expect(run.data.rejectShadowed).toEqual(["transactions"]);
    const html = prose(readFileSync(run.outPath, "utf8"));
    expect(html).toContain("transactions export never reached staging");
    expect(html).toContain("Re-import cleanly");
  });
});
