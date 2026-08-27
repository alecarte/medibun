import { describe, expect, it } from "vitest";

import {
  HOLDOUT_PCT,
  RECOVERED_DEFINITION,
  renderLeakReport,
  type LeakReportData,
} from "./leak-report.js";
import { ymd } from "../ingest/test-fixtures.js";

/** Text a reader actually sees, with the markup taken out. */
const prose = (html: string): string => html.replaceAll(/<[^>]*>/g, " ");

const data = (parts: Partial<LeakReportData> = {}): LeakReportData => ({
  practiceName: "Example Plastic Surgery",
  asOf: ymd(2026, 6, 1),
  generatedOn: ymd(2026, 6, 2),
  window: {
    revenueFrom: ymd(2024, 6, 1),
    revenueTo: ymd(2026, 6, 1),
    appointmentsFrom: ymd(2024, 6, 1),
    appointmentsTo: ymd(2026, 8, 1),
    consultsFrom: ymd(2024, 7, 1),
    consultsTo: ymd(2026, 5, 1),
  },
  staged: { patients: 40, appointments: 90, consults: 12, transactions: 300 },
  ledger: [
    {
      entity: "patients",
      runs: 1,
      rowCount: 40,
      stagedCount: 40,
      rejectedCount: 0,
      lastRunAt: ymd(2026, 6, 2),
    },
  ],
  dormant: {
    asOf: ymd(2026, 6, 1),
    categories: [
      {
        code: "injectables",
        display: "Injectables",
        expectedReturnIntervalDays: 120,
        typicalTicketCents: 50_000,
        ticketBasis: "revenue-average",
        patientCount: 8,
        expectedValueCents: 400_000,
      },
    ],
    opportunityCount: 8,
    patientCount: 8,
    expectedValueCents: 400_000,
    contactability: { withPhone: 7, withEmail: 5, withEither: 8, withNeither: 0, notInRoster: 0 },
    appointmentJoin: { rows: 90, resolvedRows: 86, futureRows: 12 },
    excludedByFutureAppointment: 3,
    categoriesWithoutTicket: 0,
  },
  consults: {
    asOf: ymd(2026, 6, 1),
    minAgeDays: 30,
    poolCount: 4,
    quotedValueCents: 3_200_000,
    withoutQuoteCount: 1,
    bookedCount: 6,
    tooRecentCount: 1,
    excludedReturnedCount: 2,
    ambiguousNameCount: 1,
    uninterpretableCount: 1,
    unresolvedNameCount: 2,
  },
  headlineCents: 3_600_000,
  ...parts,
});

describe("leak report — rendering", () => {
  it("renders one self-contained document with no external assets", () => {
    const html = renderLeakReport(data());

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    // Self-contained by requirement: nothing to fetch, nothing to run.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("carries the print stylesheet the artifact is meant to be read on", () => {
    const html = renderLeakReport(data());

    expect(html).toContain("@page");
    expect(html).toContain("@media print");
    expect(html).toContain("tabular-nums");
  });

  it("quotes the contractual definition of recovered, verbatim", () => {
    expect(renderLeakReport(data())).toContain(RECOVERED_DEFINITION);
  });

  it("states the holdout plan", () => {
    const html = prose(renderLeakReport(data()));

    expect(html).toContain(`${HOLDOUT_PCT}%`);
    expect(html).toContain("randomized at enrollment");
  });

  it("escapes every interpolated value", () => {
    const report = data();
    const html = renderLeakReport({
      ...report,
      practiceName: 'Example <img src="x"> Surgery',
      dormant: {
        ...report.dormant,
        categories: [{ ...report.dormant.categories[0]!, display: "Peels <& Masks>" }],
      },
    });

    expect(html).toContain("Peels &lt;&amp; Masks&gt;");
    expect(html).not.toContain("Peels <& Masks>");
    expect(html).not.toContain('<img src="x">');
  });

  it("keeps the written voice — no exclamation marks anywhere in the prose", () => {
    expect(prose(renderLeakReport(data()))).not.toContain("!");
  });

  it("names both pools, the dollars, and the degradations", () => {
    const html = prose(renderLeakReport(data()));

    expect(html).toContain("$36,000");
    expect(html).toContain("$4,000");
    expect(html).toContain("$32,000");
    expect(html).toContain("Injectables");
    // The consult pool's honesty section.
    expect(html).toContain("name");
    expect(html).toMatch(/ambiguous/i);
  });

  it("reads a report with nothing in it without inventing numbers", () => {
    const empty = renderLeakReport(
      data({
        window: {
          revenueFrom: null,
          revenueTo: null,
          appointmentsFrom: null,
          appointmentsTo: null,
          consultsFrom: null,
          consultsTo: null,
        },
        staged: { patients: 0, appointments: 0, consults: 0, transactions: 0 },
        ledger: [],
        dormant: {
          asOf: ymd(2026, 6, 1),
          categories: [],
          opportunityCount: 0,
          patientCount: 0,
          expectedValueCents: 0,
          contactability: {
            withPhone: 0,
            withEmail: 0,
            withEither: 0,
            withNeither: 0,
            notInRoster: 0,
          },
          appointmentJoin: { rows: 0, resolvedRows: 0, futureRows: 0 },
          excludedByFutureAppointment: 0,
          categoriesWithoutTicket: 0,
        },
        headlineCents: 0,
      }),
    );

    expect(empty).toContain("$0");
    expect(prose(empty)).not.toContain("NaN");
  });
});
