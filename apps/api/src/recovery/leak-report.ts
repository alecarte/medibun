import { asc } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  defaultAsOf,
  dormantPool,
  readStaging,
  unconvertedConsults,
  type ConsultPool,
  type DormantPool,
  type StagingSnapshot,
} from "./segmentation.js";
import { imports, type StagedEntity } from "../db/schema.js";

/**
 * The Leak Report (R2c, V1_PROPOSAL.md §5 R2). One print-quality HTML document stating,
 * in dollars, what the practice is losing — the diagnostic deliverable and the sales
 * asset, which is why the methodology and the degradations are printed as prominently as
 * the number.
 *
 * **Aggregates only.** No patient name, identity, contact detail, or row-level value can
 * appear here: the report's whole vocabulary is category labels (the practice's own
 * menu), counts, and dollars. A test renders the report over synthetic fixtures and
 * asserts that no fixture identity reaches the HTML.
 *
 * Printing a category label verbatim rests on R2a's **blocking precondition** (security
 * review, 2026-08-14): before any real export is staged, each `*_raw` column is confirmed
 * to be a coded label rather than a field an operator can type into. If one turns out to
 * be free text it is allow-listed in the adapter map, not staged verbatim — which is what
 * keeps this document's vocabulary safe to print.
 *
 * Self-contained by requirement: inline CSS, no scripts, no fonts or images to fetch. It
 * has to survive being emailed, opened offline, and printed. Colours are neutral ink and
 * paper only — no brand value is hardcoded here, because the artifact uses none.
 */

// Same driver-agnostic shape as importer.ts: node-postgres in prod, PGlite in tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<PgQueryResultHKT, any, any>;

/**
 * The contractual definition of "recovered", quoted VERBATIM from V1_PROPOSAL.md §6 (B8)
 * and printed in every report — the same sentence attribution is implemented against.
 * Edit only if that gate's text changes.
 */
export const RECOVERED_DEFINITION =
  "an appointment booked by a contact this system initiated, from a defined pool " +
  "snapshot, by a patient not in the holdout, within the campaign's attribution window " +
  "(default 45 days from last touch), excluding appointments the practice booked " +
  "through any other channel first.";

/** B8's holdout default: randomized at enrollment, immutable for the campaign. */
export const HOLDOUT_PCT = 20;

export type ImportLedgerEntry = {
  readonly entity: StagedEntity;
  readonly runs: number;
  readonly rowCount: number;
  readonly stagedCount: number;
  readonly rejectedCount: number;
  readonly lastRunAt: string;
};

/** The earliest and latest dates each export actually covers. Null when none is staged. */
export type DataWindow = {
  readonly revenueFrom: string | null;
  readonly revenueTo: string | null;
  readonly appointmentsFrom: string | null;
  readonly appointmentsTo: string | null;
  readonly consultsFrom: string | null;
  readonly consultsTo: string | null;
};

export type StagedCounts = {
  readonly patients: number;
  readonly appointments: number;
  readonly consults: number;
  readonly transactions: number;
};

export type LeakReportData = {
  readonly practiceName: string;
  readonly asOf: string;
  readonly generatedOn: string;
  readonly window: DataWindow;
  readonly staged: StagedCounts;
  readonly ledger: readonly ImportLedgerEntry[];
  readonly dormant: DormantPool;
  readonly consults: ConsultPool;
  /** Dormant expected value plus the unconverted consults' quoted dollars. */
  readonly headlineCents: number;
};

export type LeakReportOptions = {
  readonly practiceName?: string;
  /** Defaults to the export's own horizon — the newest staged transaction date. */
  readonly asOf?: string;
  readonly minAgeDays?: number;
  readonly generatedOn?: string;
};

/** No revenue is staged, so there is no horizon to anchor the report on. */
export class NoStagedRevenueError extends Error {
  constructor() {
    super("no revenue rows are staged — import the revenue export, or pass an explicit as-of date");
    this.name = "NoStagedRevenueError";
  }
}

const iso = (at: Date): string => at.toISOString().slice(0, 10);

function range(values: readonly string[]): { from: string | null; to: string | null } {
  const sorted = [...values].sort();
  return { from: sorted[0] ?? null, to: sorted.at(-1) ?? null };
}

function dataWindow(snapshot: StagingSnapshot): DataWindow {
  const revenue = range(snapshot.transactions.map((row) => row.transactionDate));
  const appointments = range(snapshot.appointments.map((row) => iso(row.startAt)));
  const consults = range(snapshot.consults.map((row) => row.consultDate));
  return {
    revenueFrom: revenue.from,
    revenueTo: revenue.to,
    appointmentsFrom: appointments.from,
    appointmentsTo: appointments.to,
    consultsFrom: consults.from,
    consultsTo: consults.to,
  };
}

/** The import ledger folded per entity: how many runs, and the latest run's counts. */
async function readLedger(db: Db): Promise<ImportLedgerEntry[]> {
  const runs = await db
    .select({
      entity: imports.entity,
      rowCount: imports.rowCount,
      stagedCount: imports.stagedCount,
      rejectedCount: imports.rejectedCount,
      createdAt: imports.createdAt,
    })
    .from(imports)
    .orderBy(asc(imports.createdAt));

  const byEntity = new Map<StagedEntity, ImportLedgerEntry>();
  for (const run of runs) {
    byEntity.set(run.entity, {
      entity: run.entity,
      runs: (byEntity.get(run.entity)?.runs ?? 0) + 1,
      rowCount: run.rowCount,
      stagedCount: run.stagedCount,
      rejectedCount: run.rejectedCount,
      lastRunAt: iso(run.createdAt),
    });
  }
  return [...byEntity.values()];
}

/** Assembles the report's data. Reads staging once; every number below traces to it. */
export async function buildLeakReport(
  db: Db,
  options: LeakReportOptions = {},
): Promise<LeakReportData> {
  const snapshot = await readStaging(db);
  const asOf = options.asOf ?? defaultAsOf(snapshot);
  if (asOf === undefined) {
    throw new NoStagedRevenueError();
  }
  const dormant = dormantPool(snapshot, { asOf });
  const consults = unconvertedConsults(snapshot, {
    asOf,
    ...(options.minAgeDays === undefined ? {} : { minAgeDays: options.minAgeDays }),
  });

  return {
    practiceName: options.practiceName ?? "The practice",
    asOf,
    generatedOn: options.generatedOn ?? iso(new Date()),
    window: dataWindow(snapshot),
    staged: {
      patients: snapshot.patients.length,
      appointments: snapshot.appointments.length,
      consults: snapshot.consults.length,
      transactions: snapshot.transactions.length,
    },
    ledger: await readLedger(db),
    dormant,
    consults,
    headlineCents: dormant.expectedValueCents + consults.quotedValueCents,
  };
}

/** Apostrophes are deliberately left alone so quoted definitions render verbatim; every
 *  attribute in this document is double-quoted, which is what makes that safe. */
const esc = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const DOLLARS = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const COUNTS = new Intl.NumberFormat("en-US");

/** Whole dollars: cents in a leak report are noise, and the methodology says so.
 *  Exported so the CLI's summary line and the document itself never disagree. */
export const formatDollars = (cents: number): string => DOLLARS.format(Math.round(cents / 100));
const money = formatDollars;
const count = (value: number): string => COUNTS.format(value);
const plural = (value: number, one: string, many: string): string =>
  `${count(value)} ${value === 1 ? one : many}`;

const BASIS_LABEL: Record<string, string> = {
  "revenue-average": "Revenue average",
  "list-price": "List price",
  "hand-set": "Hand set",
};

/** A date the browser must not break across lines at its hyphens. */
const day = (value: string): string => `<span class="date">${esc(value)}</span>`;

const windowText = (from: string | null, to: string | null): string =>
  from === null || to === null ? "none staged" : `${day(from)} to ${day(to)}`;

const STYLE = `
  :root {
    --paper: #fbf9f5;
    --panel: #f4f1e9;
    --ink: #1b1917;
    --muted: #6d675e;
    --rule: #e3ded3;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 15px;
    line-height: 1.6;
    font-variant-numeric: tabular-nums;
  }
  .sheet { max-width: 46rem; margin: 0 auto; padding: 4rem 2.5rem 6rem; }
  h1, h2, h3 {
    font-family: ui-serif, Georgia, "Times New Roman", serif;
    font-weight: 500;
    letter-spacing: -0.01em;
    margin: 0;
  }
  h1 { font-size: 2.25rem; line-height: 1.15; }
  h2 { font-size: 1.35rem; margin-bottom: 0.75rem; }
  h3 { font-size: 1rem; font-family: inherit; font-weight: 600; margin-bottom: 0.25rem; }
  p { margin: 0 0 1rem; max-width: 38rem; }
  .eyebrow {
    font-size: 0.75rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 0.75rem;
  }
  header { border-bottom: 1px solid var(--rule); padding-bottom: 2rem; margin-bottom: 3rem; }
  .facts { display: flex; flex-wrap: wrap; gap: 2rem; margin-top: 1.5rem; }
  .fact { font-size: 0.85rem; color: var(--muted); }
  .fact b { display: block; color: var(--ink); font-weight: 500; }
  section { margin-bottom: 3.5rem; }
  .headline {
    background: var(--panel);
    border: 1px solid var(--rule);
    border-radius: 6px;
    padding: 2rem;
    margin-bottom: 1.75rem;
  }
  .headline .figure {
    font-family: ui-serif, Georgia, "Times New Roman", serif;
    font-size: 3.25rem;
    line-height: 1;
    letter-spacing: -0.02em;
  }
  .headline .caption { color: var(--muted); font-size: 0.9rem; margin-top: 0.5rem; }
  .split { display: flex; flex-wrap: wrap; gap: 2.5rem; margin-bottom: 1.75rem; }
  .split > div { flex: 1 1 14rem; }
  .amount { font-size: 1.5rem; font-family: ui-serif, Georgia, serif; }
  table { width: 100%; border-collapse: collapse; margin: 0 0 1.25rem; font-size: 0.9rem; }
  caption { text-align: left; color: var(--muted); font-size: 0.85rem; padding-bottom: 0.5rem; }
  th, td { padding: 0.55rem 0.75rem; border-bottom: 1px solid var(--rule); text-align: left; }
  th {
    font-weight: 600;
    font-size: 0.75rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }
  td.num, th.num { text-align: right; }
  td.basis { color: var(--muted); white-space: nowrap; }
  .date { white-space: nowrap; }
  tbody tr:last-child td { border-bottom: none; }
  tfoot td { border-top: 1px solid var(--ink); border-bottom: none; font-weight: 600; }
  blockquote {
    margin: 0 0 1rem;
    padding: 1rem 1.25rem;
    background: var(--panel);
    border-left: 2px solid var(--ink);
    max-width: 38rem;
  }
  dl { margin: 0 0 1rem; max-width: 38rem; }
  dt { font-weight: 600; margin-top: 0.75rem; }
  dd { margin: 0; color: var(--muted); }
  ul { margin: 0 0 1rem; padding-left: 1.1rem; max-width: 38rem; }
  li { margin-bottom: 0.35rem; }
  footer {
    border-top: 1px solid var(--rule);
    padding-top: 1.5rem;
    color: var(--muted);
    font-size: 0.8rem;
  }
  @page { size: letter; margin: 18mm; }
  @media print {
    body { background: #fff; font-size: 10.5pt; }
    .sheet { max-width: none; padding: 0; }
    section, table, .headline { break-inside: avoid; }
    h2 { break-after: avoid; }
  }
`;

function dormantSection(pool: DormantPool): string {
  const rows =
    pool.categories.length === 0
      ? `<tr><td colspan="5">No category in this export is both dated and given an expected-return interval.</td></tr>`
      : pool.categories
          .map(
            (category) => `<tr>
            <td>${esc(category.display)}</td>
            <td class="num">${count(category.patientCount)}</td>
            <td class="num">${
              category.typicalTicketCents === null ? "—" : money(category.typicalTicketCents)
            }</td>
            <td class="basis">${
              category.ticketBasis === null ? "not set" : BASIS_LABEL[category.ticketBasis]
            }</td>
            <td class="num">${money(category.expectedValueCents)}</td>
          </tr>`,
          )
          .join("");

  const contact = pool.contactability;
  return `<section id="dormant">
      <h2>Dormant patients</h2>
      <p>
        A patient is dormant in a service category when their last paid visit in that category is
        older than the category's expected-return interval and they hold no appointment after
        ${day(pool.asOf)}. One patient can be dormant in more than one category; each pair is a
        separate opportunity, and the campaign works them one patient at a time.
      </p>
      <table>
        <caption>
          ${plural(pool.opportunityCount, "opportunity", "opportunities")} across
          ${plural(pool.patientCount, "patient", "patients")}.
        </caption>
        <thead>
          <tr>
            <th>Category</th>
            <th class="num">Patients</th>
            <th class="num">Typical ticket</th>
            <th>Basis</th>
            <th class="num">Expected value</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            <td class="num">${count(pool.opportunityCount)}</td>
            <td class="num"></td>
            <td></td>
            <td class="num">${money(pool.expectedValueCents)}</td>
          </tr>
        </tfoot>
      </table>
      <h3>How many can be reached</h3>
      <p>
        Outreach only works a patient the practice can contact. Of the
        ${plural(pool.patientCount, "patient", "patients")} in this pool,
        ${count(contact.withPhone)} carry a phone number and ${count(contact.withEmail)} carry an
        email — ${count(contact.withEither)} carry at least one. ${count(contact.withNeither)} carry
        neither and cannot be enrolled${
          contact.notInRoster === 0
            ? ""
            : `, and ${count(contact.notInRoster)} appear in the revenue export but not in the patient roster, so their contact details are unknown`
        }.
      </p>
      <p>
        ${count(pool.excludedByFutureAppointment)} otherwise-dormant
        ${pool.excludedByFutureAppointment === 1 ? "patient was" : "patients were"} left out of the
        pool for already holding a future appointment. That exclusion is the point: this engine
        never contacts a patient who has already rebooked.
      </p>
    </section>`;
}

function consultSection(pool: ConsultPool): string {
  return `<section id="consults">
      <h2>Unconverted consults</h2>
      <div class="split">
        <div>
          <div class="amount">${count(pool.poolCount)}</div>
          <div class="fact">consults quoted and not booked</div>
        </div>
        <div>
          <div class="amount">${money(pool.quotedValueCents)}</div>
          <div class="fact">in quoted work, at the practice's own quoted prices</div>
        </div>
      </div>
      <p>
        A consult joins this pool when its booked column reads as not booked and it is at least
        ${plural(pool.minAgeDays, "day", "days")} old at ${day(pool.asOf)} — a fresher consult is
        still in flight, not lost. Where the patient can be identified and has since paid for a
        visit or booked ahead, the consult is removed.
      </p>
      <h3>What this pool does not cover</h3>
      <p>
        This number is deliberately narrow. The source report covers quote-created surgical
        consults only, so consults that never produced a quote are invisible to it. The report
        also carries a patient name with no id, date of birth, or phone to disambiguate it, so the
        return check runs on the name alone.
      </p>
      <ul>
        <li>${plural(pool.excludedReturnedCount, "consult", "consults")} removed: the patient came back through another channel.</li>
        <li>${plural(pool.ambiguousNameCount, "consult", "consults")} held back as ambiguous — the name matches more than one patient, and a person resolves that, not this report.</li>
        <li>${plural(pool.uninterpretableCount, "consult", "consults")} whose booked column carried no answer this report could read; none were assumed either way.</li>
        <li>${plural(pool.unresolvedNameCount, "consult", "consults")} kept in the pool whose name matched no roster record, so whether they returned is unknown.</li>
        <li>${plural(pool.withoutQuoteCount, "consult", "consults")} in the pool carry no quoted amount and contribute nothing to the dollars above.</li>
        <li>${plural(pool.bookedCount, "consult", "consults")} read as booked and ${plural(pool.tooRecentCount, "consult", "consults")} as too recent to call lost.</li>
      </ul>
    </section>`;
}

function methodologySection(data: LeakReportData): string {
  return `<section id="methodology">
      <h2>Methodology and definitions</h2>
      <h3>Typical ticket</h3>
      <p>
        A visit is the sum of one patient's revenue line items on one date in one category, with
        refunds netted into the visit they belong to. A category's typical ticket is the average of
        those visit totals across the whole staged window — actual money collected, not list
        prices. Where a category has no usable revenue history, an operator-supplied figure is used
        instead and the basis column says so. Visits netting to zero or less are refunds rather
        than tickets and are left out of the average.
      </p>
      <p>
        Ticket values are deliberately conservative. Where a figure comes from the practice's price
        list rather than from revenue, it excludes anesthesia and facility fees, so the real value
        of a recovered surgical booking is higher than the figure printed here. Every amount in
        this report is rounded to whole dollars.
      </p>
      <h3>Expected-return intervals</h3>
      <p>
        Each category's interval is set by hand, as clinical cadence judgment, and is never derived
        from the data. A category with no interval defines no dormancy and contributes nothing to
        the pool — retail and garments, for example, are not appointments to recover.
      </p>
      <h3>What counts as recovered</h3>
      <p>
        Every campaign report measures against one definition, fixed before the campaign starts:
      </p>
      <blockquote>${esc(RECOVERED_DEFINITION)}</blockquote>
      <h3>The holdout</h3>
      <p>
        ${HOLDOUT_PCT}% of the enrolled pool is held out, randomized at enrollment and immutable for
        the campaign. Held-out patients receive zero touches, and the recovered count is reported
        against their rebooking rate — so the number credited to this engine is the difference it
        made, not the bookings that would have happened anyway.
      </p>
      <p>
        This report is a diagnostic of ${esc(data.practiceName)}'s own data as of
        ${day(data.asOf)}. It is an estimate of opportunity, not a forecast of revenue.
      </p>
    </section>`;
}

function dataQualitySection(data: LeakReportData): string {
  const ledger =
    data.ledger.length === 0
      ? `<tr><td colspan="5">No imports recorded.</td></tr>`
      : data.ledger
          .map(
            (entry) => `<tr>
            <td>${esc(entry.entity)}</td>
            <td class="num">${count(entry.rowCount)}</td>
            <td class="num">${count(entry.stagedCount)}</td>
            <td class="num">${count(entry.rejectedCount)}</td>
            <td>${day(entry.lastRunAt)}</td>
          </tr>`,
          )
          .join("");

  const join = data.dormant.appointmentJoin;
  const coverage = join.rows === 0 ? 0 : Math.round((join.resolvedRows / join.rows) * 100);

  return `<section id="data-quality">
      <h2>Data quality</h2>
      <table>
        <caption>Most recent import per export, as recorded in the import ledger.</caption>
        <thead>
          <tr>
            <th>Export</th>
            <th class="num">Rows read</th>
            <th class="num">Staged</th>
            <th class="num">Rejected</th>
            <th>Last run</th>
          </tr>
        </thead>
        <tbody>${ledger}</tbody>
      </table>
      <p>
        Staging currently holds ${count(data.staged.patients)} patient records,
        ${count(data.staged.appointments)} appointments, ${count(data.staged.consults)} consults,
        and ${count(data.staged.transactions)} revenue rows.
      </p>
      <h3>Reconciliation</h3>
      <p>
        Each source export declares its own row total. The import tool checks every file against
        that total as it runs and reports the result at the terminal; the check is not retained in
        the ledger, so the import session's output is the record of it.
      </p>
      <h3>Appointment matching</h3>
      <p>
        The appointment export carries no patient id, so its rows are matched to the roster on
        name, date of birth, and phone together. ${count(join.resolvedRows)} of
        ${count(join.rows)} rows matched (${count(coverage)}%). A row that does not match cannot
        remove anyone from the pool, so the pool is, if anything, slightly over-counted rather than
        quietly filtered.
      </p>
      <h3>Export horizon</h3>
      <p>
        Future appointments were read from an export covering ${windowText(
          data.window.appointmentsFrom,
          data.window.appointmentsTo,
        )}. The "no future appointment" half of the dormant definition is only as good as that
        forward window: a booking made after the export was taken, or beyond its end date, is not
        visible here and is re-checked at enrollment.
      </p>
    </section>`;
}

/** Renders one self-contained document. Pure: the same data renders the same bytes. */
export function renderLeakReport(data: LeakReportData): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Leak Report — ${esc(data.practiceName)}</title>
<style>${STYLE}</style>
</head>
<body>
<article class="sheet">
  <header>
    <div class="eyebrow">Leak Report</div>
    <h1>${esc(data.practiceName)}</h1>
    <div class="facts">
      <div class="fact"><b>${day(data.asOf)}</b>As of</div>
      <div class="fact"><b>${windowText(data.window.revenueFrom, data.window.revenueTo)}</b>Revenue window</div>
      <div class="fact"><b>${windowText(data.window.consultsFrom, data.window.consultsTo)}</b>Consult window</div>
      <div class="fact"><b>${day(data.generatedOn)}</b>Prepared</div>
    </div>
  </header>

  <section id="summary">
    <h2>What the practice is losing</h2>
    <div class="headline">
      <div class="figure">${money(data.headlineCents)}</div>
      <div class="caption">
        identified across two pools of patients the practice has already paid to acquire
      </div>
    </div>
    <div class="split">
      <div>
        <h3>Dormant patients</h3>
        <div class="amount">${money(data.dormant.expectedValueCents)}</div>
        <div class="fact">
          ${plural(data.dormant.opportunityCount, "opportunity", "opportunities")} across
          ${plural(data.dormant.patientCount, "patient", "patients")}, valued at each category's
          typical ticket
        </div>
      </div>
      <div>
        <h3>Unconverted consults</h3>
        <div class="amount">${money(data.consults.quotedValueCents)}</div>
        <div class="fact">
          ${plural(data.consults.poolCount, "consult", "consults")} quoted and never booked, valued
          at the quoted amount
        </div>
      </div>
    </div>
    <p>
      Both figures are opportunity, not revenue: they say what is sitting in the practice's own
      records, unworked. The sections below state exactly how each was counted, and what each
      count leaves out.
    </p>
  </section>

  ${dormantSection(data.dormant)}
  ${consultSection(data.consults)}
  ${methodologySection(data)}
  ${dataQualitySection(data)}

  <footer>
    Prepared for ${esc(data.practiceName)} on ${day(data.generatedOn)}. Every figure in this
    document is an aggregate; no patient name, identifier, or contact detail appears anywhere in
    it. Handle as practice-confidential.
  </footer>
</article>
</body>
</html>
`;
}
