import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { runLeakReportCli, runSeedCategoriesCli } from "./cli.js";
import { RECOVERED_DEFINITION } from "./leak-report.js";
import { createFourDAdapter } from "../ingest/adapter-4d.js";
import { createImportService } from "../ingest/importer.js";
import { csvFile, reportFile, ymd, ymdhm } from "../ingest/test-fixtures.js";
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
/** The document's prose, markup stripped and whitespace collapsed — how a reader reads
 *  it, so assertions do not depend on where the template happens to wrap. */
let prose: string;

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
  prose = html.replaceAll(/<[^>]*>/g, " ").replaceAll(/\s+/g, " ");
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
    expect(prose).toContain("3 opportunities across 3 patients");
    // 2 dormant injectables patients at $500, plus 1 dormant peels patient at $200.
    expect(prose).toContain("$1,200");
    expect(prose).toContain(INJECTABLES);
    expect(prose).toContain("1 otherwise-dormant patient was left out of the pool");
  });

  it("counts the unconverted consults and every degradation beside them", () => {
    // Booked, too recent, returned, ambiguous, and uninterpretable are each held back.
    expect(prose).toContain("2 consults quoted and not booked");
    expect(prose).toContain("$8,000");
    expect(prose).toContain("1 consult removed");
    expect(prose).toContain("1 consult held back as ambiguous");
    expect(prose).toContain("1 consult whose booked column carried no answer");
    expect(prose).toContain("1 consult kept in the pool whose name matched no roster record");
    expect(prose).toContain("1 consult read as booked and 1 consult as too recent");
  });

  it("states one headline figure — both pools", () => {
    expect(prose).toContain("$9,200");
  });

  it("reports the appointment join honestly rather than hiding the misses", () => {
    expect(prose).toContain("2 of 3 rows matched (67%)");
  });

  // Staged instants are timestamptz; the report dates them in the PRACTICE's zone. The
  // 21:30 appointment falls on the next UTC day, and printing that would tell a practice
  // its export covers a day it does not.
  it("dates the appointment window in the practice's zone, not UTC", () => {
    expect(prose).toContain(`${ymd(2025, 11, 1)} to ${ymd(2026, 8, 1)}`);
    expect(prose).not.toContain(ymd(2026, 8, 2));
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

  it("re-asserts owner-only permissions when overwriting an existing report", async () => {
    // writeFileSync's mode applies on CREATE only — a pre-existing world-readable file
    // would otherwise keep its looser permissions across a re-run.
    const stalePath = join(dir, "stale-report.html");
    writeFileSync(stalePath, "stale");
    chmodSync(stalePath, 0o644);

    await runLeakReportCli({ argv: ["--out", stalePath, "--timezone", TZ], db, out: () => {} });

    expect(statSync(stalePath).mode & 0o777).toBe(0o600);
    expect(readFileSync(stalePath, "utf8")).not.toContain("stale");
  });
});
