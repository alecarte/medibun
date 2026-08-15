import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONSULT_MIN_AGE_DAYS,
  defaultAsOf,
  dormantPool,
  nameKey,
  readBooked,
  unconvertedConsults,
  type AppointmentRow,
  type CategoryRow,
  type ConsultRow,
  type RosterRow,
  type StagingSnapshot,
} from "./segmentation.js";
import { ymd } from "../ingest/test-fixtures.js";

/**
 * Pure-layer tests: snapshots are built by hand so every pool rule is pinned without a
 * database. The PGlite round-trip (staging → seed → report) lives in pipeline.test.ts.
 */

const AS_OF = ymd(2026, 6, 1);
/** The practice's own zone — four hours behind UTC on the as-of date. */
const TZ = "America/New_York";

const snapshot = (parts: Partial<StagingSnapshot>): StagingSnapshot => ({
  patients: [],
  appointments: [],
  consults: [],
  transactions: [],
  categories: [],
  superseded: { patients: 0, appointments: 0, consults: 0, transactions: 0 },
  ...parts,
});

const category = (parts: Partial<CategoryRow>): CategoryRow => ({
  code: "injectables",
  display: "Injectables",
  expectedReturnIntervalDays: 90,
  typicalTicketCents: 50_000,
  ticketBasis: "revenue-average",
  ...parts,
});

const patient = (parts: Partial<RosterRow> & { sourceIdentity: string }): RosterRow => ({
  firstName: "Testerly",
  lastName: "Fakeman",
  dob: ymd(1970, 4, 12),
  phone: "555-0100",
  email: null,
  ...parts,
});

const paid = (patientId: string, date: string, label: string, cents = 50_000) => ({
  patientSourceIdentity: patientId,
  transactionDate: date,
  serviceCategoryRaw: label,
  amountCents: cents,
});

const appointment = (parts: Partial<AppointmentRow> & { startAt: Date }): AppointmentRow => ({
  patientSourceIdentity: null,
  patientName: null,
  dob: null,
  phone: null,
  ...parts,
});

const consult = (parts: Partial<ConsultRow> & { patientName: string }): ConsultRow => ({
  patientSourceIdentity: null,
  consultDate: ymd(2026, 1, 5),
  quoteAmountCents: 800_000,
  bookedRaw: "No",
  ...parts,
});

/** A day count before as-of, as a calendar date. */
const daysBefore = (days: number): string =>
  new Date(Date.parse(`${AS_OF}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

describe("as-of", () => {
  it("defaults to the export's own horizon — the newest transaction date", () => {
    const staging = snapshot({
      transactions: [
        paid("p-1", ymd(2026, 2, 3), "Injectables"),
        paid("p-1", AS_OF, "Injectables"),
      ],
    });

    expect(defaultAsOf(staging)).toBe(AS_OF);
  });

  it("has no default when no revenue is staged", () => {
    expect(defaultAsOf(snapshot({}))).toBeUndefined();
  });
});

describe("dormant pool", () => {
  it("leaves a patient out on the day the interval comes due, and pools them the day after", () => {
    const atEdge = snapshot({
      categories: [category({})],
      patients: [patient({ sourceIdentity: "p-1" })],
      transactions: [paid("p-1", daysBefore(90), "Injectables")],
    });
    const pastEdge = snapshot({
      ...atEdge,
      transactions: [paid("p-1", daysBefore(91), "Injectables")],
    });

    expect(dormantPool(atEdge, { asOf: AS_OF, timeZone: TZ }).opportunityCount).toBe(0);
    expect(dormantPool(pastEdge, { asOf: AS_OF, timeZone: TZ }).opportunityCount).toBe(1);
  });

  it("measures dormancy from the patient's LAST paid visit in the category", () => {
    const staging = snapshot({
      categories: [category({})],
      patients: [patient({ sourceIdentity: "p-1" })],
      transactions: [
        paid("p-1", daysBefore(400), "Injectables"),
        paid("p-1", daysBefore(30), "Injectables"),
      ],
    });

    expect(dormantPool(staging, { asOf: AS_OF, timeZone: TZ }).opportunityCount).toBe(0);
  });

  it("ignores a category with no expected-return interval", () => {
    const staging = snapshot({
      categories: [
        category({ code: "garments", display: "Garments", expectedReturnIntervalDays: null }),
      ],
      patients: [patient({ sourceIdentity: "p-1" })],
      transactions: [paid("p-1", daysBefore(900), "Garments")],
    });

    expect(dormantPool(staging, { asOf: AS_OF, timeZone: TZ }).opportunityCount).toBe(0);
  });

  it("ignores a refunded visit — dormancy runs off PAID visits", () => {
    const staging = snapshot({
      categories: [category({})],
      patients: [patient({ sourceIdentity: "p-1" })],
      transactions: [
        paid("p-1", daysBefore(200), "Injectables", 50_000),
        paid("p-1", daysBefore(30), "Injectables", 50_000),
        paid("p-1", daysBefore(30), "Injectables", -50_000),
      ],
    });

    // The recent visit netted to nothing, so the 200-day-old one is the last paid visit.
    expect(dormantPool(staging, { asOf: AS_OF, timeZone: TZ }).opportunityCount).toBe(1);
  });

  it("counts one opportunity per patient per category, and each patient once", () => {
    const staging = snapshot({
      categories: [category({}), category({ code: "peels", display: "Peels" })],
      patients: [patient({ sourceIdentity: "p-1" })],
      transactions: [
        paid("p-1", daysBefore(200), "Injectables"),
        paid("p-1", daysBefore(200), "Peels"),
      ],
    });

    const pool = dormantPool(staging, { asOf: AS_OF, timeZone: TZ });

    expect(pool).toMatchObject({ opportunityCount: 2, patientCount: 1 });
    expect(pool.categories.map((c) => [c.code, c.patientCount])).toEqual([
      ["injectables", 1],
      ["peels", 1],
    ]);
  });

  it("values each category at its typical ticket and totals the pool", () => {
    const staging = snapshot({
      categories: [
        category({ typicalTicketCents: 50_000 }),
        category({ code: "peels", display: "Peels", typicalTicketCents: 20_000 }),
      ],
      patients: [patient({ sourceIdentity: "p-1" }), patient({ sourceIdentity: "p-2" })],
      transactions: [
        paid("p-1", daysBefore(200), "Injectables"),
        paid("p-2", daysBefore(200), "Injectables"),
        paid("p-1", daysBefore(200), "Peels"),
      ],
    });

    const pool = dormantPool(staging, { asOf: AS_OF, timeZone: TZ });

    expect(pool.expectedValueCents).toBe(120_000);
    expect(pool.categories.find((c) => c.code === "injectables")!.expectedValueCents).toBe(100_000);
  });

  it("counts a category with no ticket instead of valuing it at zero", () => {
    const staging = snapshot({
      categories: [category({ typicalTicketCents: null, ticketBasis: null })],
      patients: [patient({ sourceIdentity: "p-1" })],
      transactions: [paid("p-1", daysBefore(200), "Injectables")],
    });

    const pool = dormantPool(staging, { asOf: AS_OF, timeZone: TZ });

    expect(pool.expectedValueCents).toBe(0);
    expect(pool.categoriesWithoutTicket).toBe(1);
  });

  describe("future appointments", () => {
    const dormant = (parts: Partial<StagingSnapshot>): StagingSnapshot =>
      snapshot({
        categories: [category({})],
        patients: [patient({ sourceIdentity: "p-1" })],
        transactions: [paid("p-1", daysBefore(200), "Injectables")],
        ...parts,
      });

    it("excludes a patient matched by name, DOB, and phone", () => {
      const staging = dormant({
        appointments: [
          appointment({
            patientName: "Testerly Fakeman",
            dob: ymd(1970, 4, 12),
            phone: "(555) 010-0",
            startAt: new Date(Date.parse(`${AS_OF}T00:00:00Z`) + 10 * 86_400_000),
          }),
        ],
      });

      const pool = dormantPool(staging, { asOf: AS_OF, timeZone: TZ });

      expect(pool.opportunityCount).toBe(0);
      expect(pool.appointmentJoin).toMatchObject({ rows: 1, resolvedRows: 1 });
    });

    it("matches a name printed in the other order", () => {
      const staging = dormant({
        appointments: [
          appointment({
            patientName: "Fakeman, Testerly",
            dob: ymd(1970, 4, 12),
            phone: "5550100",
            startAt: new Date(Date.parse(`${AS_OF}T00:00:00Z`) + 10 * 86_400_000),
          }),
        ],
      });

      expect(dormantPool(staging, { asOf: AS_OF, timeZone: TZ }).opportunityCount).toBe(0);
    });

    it("joins straight through when the export carries a patient id", () => {
      const staging = dormant({
        appointments: [
          appointment({
            patientSourceIdentity: "p-1",
            startAt: new Date(Date.parse(`${AS_OF}T00:00:00Z`) + 10 * 86_400_000),
          }),
        ],
      });

      expect(dormantPool(staging, { asOf: AS_OF, timeZone: TZ }).opportunityCount).toBe(0);
    });

    // The cutoff is the practice's own midnight. Read in UTC it under-excludes east of
    // UTC, where the as-of day has already ended — and under-excluding is the one
    // mistake this engine cannot make: it contacts a patient who has already rebooked.
    it("excludes an appointment that is the next morning in the practice's zone", () => {
      const staging = dormant({
        appointments: [
          appointment({
            patientSourceIdentity: "p-1",
            startAt: new Date(Date.parse(`${AS_OF}T22:00:00Z`)),
          }),
        ],
      });

      // 09:00 the morning after the as-of date, eleven hours east of UTC.
      expect(
        dormantPool(staging, { asOf: AS_OF, timeZone: "Pacific/Guadalcanal" }).opportunityCount,
      ).toBe(0);
      // The same instant is still the as-of afternoon four hours behind UTC.
      expect(dormantPool(staging, { asOf: AS_OF, timeZone: TZ }).opportunityCount).toBe(1);
    });

    // The bound itself: the practice's midnight opens the day after, so a booking on it
    // is a future booking.
    it("excludes an appointment at the practice's midnight the morning after", () => {
      const staging = dormant({
        appointments: [
          appointment({
            patientSourceIdentity: "p-1",
            // 00:00 on the following day in a practice four hours behind UTC.
            startAt: new Date(Date.parse(`${ymd(2026, 6, 2)}T04:00:00Z`)),
          }),
        ],
      });

      expect(dormantPool(staging, { asOf: AS_OF, timeZone: TZ }).opportunityCount).toBe(0);
    });

    it("keeps an evening appointment on the as-of day itself in the pool", () => {
      const staging = dormant({
        appointments: [
          appointment({
            patientSourceIdentity: "p-1",
            // 21:00 practice-local on the as-of day — already the next day in UTC.
            startAt: new Date(Date.parse(`${ymd(2026, 6, 2)}T01:00:00Z`)),
          }),
        ],
      });

      expect(dormantPool(staging, { asOf: AS_OF, timeZone: TZ }).opportunityCount).toBe(1);
    });

    it("keeps a PAST appointment from excluding anyone", () => {
      const staging = dormant({
        appointments: [
          appointment({
            patientSourceIdentity: "p-1",
            startAt: new Date(Date.parse(`${AS_OF}T00:00:00Z`) - 10 * 86_400_000),
          }),
        ],
      });

      expect(dormantPool(staging, { asOf: AS_OF, timeZone: TZ }).opportunityCount).toBe(1);
    });

    it("still pools a patient whose appointment rows will not join, and says so", () => {
      const staging = dormant({
        appointments: [
          appointment({
            patientName: "Testerly Fakeman",
            dob: null,
            phone: null,
            startAt: new Date(Date.parse(`${AS_OF}T00:00:00Z`) + 10 * 86_400_000),
          }),
        ],
      });

      const pool = dormantPool(staging, { asOf: AS_OF, timeZone: TZ });

      expect(pool.opportunityCount).toBe(1);
      expect(pool.appointmentJoin).toMatchObject({ rows: 1, resolvedRows: 0 });
    });
  });

  it("splits the pool by how the campaign could reach it", () => {
    const staging = snapshot({
      categories: [category({})],
      patients: [
        patient({ sourceIdentity: "p-1", phone: "555-0100", email: null }),
        patient({ sourceIdentity: "p-2", phone: null, email: "p-2@example.invalid" }),
        patient({ sourceIdentity: "p-3", phone: null, email: null }),
      ],
      transactions: [
        paid("p-1", daysBefore(200), "Injectables"),
        paid("p-2", daysBefore(200), "Injectables"),
        paid("p-3", daysBefore(200), "Injectables"),
        paid("p-4", daysBefore(200), "Injectables"),
      ],
    });

    expect(dormantPool(staging, { asOf: AS_OF, timeZone: TZ }).contactability).toEqual({
      withPhone: 1,
      withEmail: 1,
      withEither: 2,
      withNeither: 1,
      notInRoster: 1,
    });
  });
});

describe("booked labels", () => {
  it("reads the yes-shaped and no-shaped labels an export may print", () => {
    expect(["Yes", "y", "TRUE", "1", "Booked", "X"].map(readBooked)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(["No", "n", "false", "0", "Not Booked"].map(readBooked)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("refuses to guess anything else, blanks included", () => {
    expect(readBooked(null)).toBeUndefined();
    expect(readBooked("")).toBeUndefined();
    expect(readBooked("pending")).toBeUndefined();
  });
});

describe("unconverted consults", () => {
  const unbooked = (parts: Partial<StagingSnapshot>): StagingSnapshot =>
    snapshot({ consults: [consult({ patientName: "Otherly Fakeman" })], ...parts });

  it("pools an unbooked consult and values it at the quoted dollars", () => {
    const pool = unconvertedConsults(unbooked({}), { asOf: AS_OF, timeZone: TZ });

    expect(pool).toMatchObject({
      poolCount: 1,
      quotedValueCents: 800_000,
      withoutQuoteCount: 0,
      minAgeDays: DEFAULT_CONSULT_MIN_AGE_DAYS,
    });
  });

  it("leaves a booked consult out", () => {
    const staging = unbooked({
      consults: [consult({ patientName: "Otherly Fakeman", bookedRaw: "Yes" })],
    });

    expect(unconvertedConsults(staging, { asOf: AS_OF, timeZone: TZ })).toMatchObject({
      poolCount: 0,
      bookedCount: 1,
    });
  });

  it("counts a label it cannot read rather than guessing it into the pool", () => {
    const staging = unbooked({
      consults: [consult({ patientName: "Otherly Fakeman", bookedRaw: "maybe" })],
    });

    expect(unconvertedConsults(staging, { asOf: AS_OF, timeZone: TZ })).toMatchObject({
      poolCount: 0,
      uninterpretableCount: 1,
    });
  });

  it("holds back a consult too fresh to call lost", () => {
    const staging = unbooked({
      consults: [consult({ patientName: "Otherly Fakeman", consultDate: daysBefore(29) })],
    });

    expect(unconvertedConsults(staging, { asOf: AS_OF, timeZone: TZ })).toMatchObject({
      poolCount: 0,
      tooRecentCount: 1,
    });
    expect(
      unconvertedConsults(staging, { asOf: AS_OF, timeZone: TZ, minAgeDays: 14 }).poolCount,
    ).toBe(1);
  });

  it("counts a quote-less consult separately instead of valuing it at zero", () => {
    const staging = unbooked({
      consults: [consult({ patientName: "Otherly Fakeman", quoteAmountCents: null })],
    });

    expect(unconvertedConsults(staging, { asOf: AS_OF, timeZone: TZ })).toMatchObject({
      poolCount: 1,
      quotedValueCents: 0,
      withoutQuoteCount: 1,
    });
  });

  it("excludes a patient who came back through another channel — a later paid visit", () => {
    const staging = unbooked({
      patients: [patient({ sourceIdentity: "p-9", firstName: "Otherly" })],
      consults: [consult({ patientName: "Otherly Fakeman", consultDate: daysBefore(120) })],
      transactions: [paid("p-9", daysBefore(60), "Injectables")],
    });

    expect(unconvertedConsults(staging, { asOf: AS_OF, timeZone: TZ })).toMatchObject({
      poolCount: 0,
      excludedReturnedCount: 1,
    });
  });

  it("excludes a patient holding a future appointment", () => {
    const staging = unbooked({
      patients: [patient({ sourceIdentity: "p-9", firstName: "Otherly" })],
      appointments: [
        appointment({
          patientSourceIdentity: "p-9",
          startAt: new Date(Date.parse(`${AS_OF}T00:00:00Z`) + 5 * 86_400_000),
        }),
      ],
    });

    expect(unconvertedConsults(staging, { asOf: AS_OF, timeZone: TZ })).toMatchObject({
      poolCount: 0,
      excludedReturnedCount: 1,
    });
  });

  it("keeps a patient whose only paid visit PREDATES the consult", () => {
    const staging = unbooked({
      patients: [patient({ sourceIdentity: "p-9", firstName: "Otherly" })],
      consults: [consult({ patientName: "Otherly Fakeman", consultDate: daysBefore(60) })],
      transactions: [paid("p-9", daysBefore(120), "Injectables")],
    });

    expect(unconvertedConsults(staging, { asOf: AS_OF, timeZone: TZ }).poolCount).toBe(1);
  });

  it("flags a name that matches two patients rather than picking one", () => {
    const staging = unbooked({
      patients: [
        patient({ sourceIdentity: "p-9", firstName: "Otherly" }),
        patient({ sourceIdentity: "p-10", firstName: "Otherly", dob: ymd(1981, 2, 3) }),
      ],
    });

    expect(unconvertedConsults(staging, { asOf: AS_OF, timeZone: TZ })).toMatchObject({
      poolCount: 0,
      ambiguousNameCount: 1,
    });
  });

  it("keeps a consult whose name is in no roster row, and says so", () => {
    const pool = unconvertedConsults(unbooked({}), { asOf: AS_OF, timeZone: TZ });

    expect(pool).toMatchObject({ poolCount: 1, unresolvedNameCount: 1 });
  });
});

describe("name keys", () => {
  it("folds case, punctuation, and order", () => {
    expect(nameKey("Fakeman, Testerly")).toBe(nameKey("testerly   fakeman"));
  });

  it("is empty for a name with no letters to key on", () => {
    expect(nameKey(" # ")).toBe("");
  });
});
