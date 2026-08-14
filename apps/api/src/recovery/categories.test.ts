import { describe, expect, it } from "vitest";

import {
  categoryCode,
  ConfigError,
  parseCadenceConfig,
  typicalTickets,
  type TransactionInput,
} from "./categories.js";
import { ymd } from "../ingest/test-fixtures.js";

const D1 = ymd(2026, 3, 2);
const D2 = ymd(2026, 3, 9);

const line = (
  patient: string | null,
  date: string,
  category: string | null,
  amountCents: number,
): TransactionInput => ({
  patientSourceIdentity: patient,
  transactionDate: date,
  serviceCategoryRaw: category,
  amountCents,
});

describe("category codes", () => {
  it("slugs a source label and leaves an already-slugged code alone", () => {
    expect(categoryCode("Injectables")).toBe("injectables");
    expect(categoryCode("Surgery — Breast")).toBe("surgery-breast");
    expect(categoryCode("laser-resurfacing")).toBe("laser-resurfacing");
  });

  it("falls back to the folded label when a label slugs to nothing", () => {
    // A code has to stay unique per label: an empty slug would collide every such
    // category onto one row.
    expect(categoryCode("—")).toBe("—");
    expect(categoryCode(" ++ ")).toBe("++");
  });
});

describe("typical tickets — per-visit grouping", () => {
  it("sums line items into one visit and averages visits per category", () => {
    const summary = typicalTickets([
      line("p-1", D1, "Injectables", 30_000),
      line("p-1", D1, "Injectables", 15_000),
      line("p-2", D2, "Injectables", 25_000),
    ]);

    expect(summary.categories).toEqual([
      { code: "injectables", display: "Injectables", visitCount: 2, typicalTicketCents: 35_000 },
    ]);
  });

  it("nets a refund into the visit it belongs to", () => {
    const summary = typicalTickets([
      line("p-1", D1, "Injectables", 30_000),
      line("p-1", D1, "Injectables", -10_000),
    ]);

    expect(summary.categories[0]).toMatchObject({ visitCount: 1, typicalTicketCents: 20_000 });
  });

  it("rounds the average to whole cents", () => {
    const summary = typicalTickets([
      line("p-1", D1, "Injectables", 45_000),
      line("p-2", D2, "Injectables", 25_001),
    ]);

    expect(summary.categories[0]!.typicalTicketCents).toBe(35_001);
  });

  it("keeps the source label verbatim as the display", () => {
    const summary = typicalTickets([line("p-1", D1, "Skin Care / Peels", 12_000)]);

    expect(summary.categories[0]).toMatchObject({
      code: "skin-care-peels",
      display: "Skin Care / Peels",
    });
  });

  it("separates categories and orders them by display", () => {
    const summary = typicalTickets([
      line("p-1", D1, "Injectables", 40_000),
      line("p-1", D1, "Body", 10_000),
    ]);

    expect(summary.categories.map((c) => c.code)).toEqual(["body", "injectables"]);
  });

  it("counts rows it cannot attribute instead of averaging them in", () => {
    const summary = typicalTickets([
      line("p-1", D1, null, 30_000),
      line(null, D1, "Injectables", 30_000),
      line("p-2", D2, "Injectables", 20_000),
    ]);

    expect(summary).toMatchObject({ rowsWithoutCategory: 1, rowsWithoutPatient: 1 });
    expect(summary.categories[0]).toMatchObject({ visitCount: 1, typicalTicketCents: 20_000 });
  });

  it("drops a visit that nets to nothing — a refund is not a ticket", () => {
    const summary = typicalTickets([
      line("p-1", D1, "Injectables", -20_000),
      line("p-2", D2, "Injectables", 30_000),
    ]);

    expect(summary).toMatchObject({ nonPositiveVisits: 1 });
    expect(summary.categories[0]).toMatchObject({ visitCount: 1, typicalTicketCents: 30_000 });
  });

  it("reports no categories at all for an empty export", () => {
    expect(typicalTickets([]).categories).toEqual([]);
  });
});

describe("cadence config", () => {
  const config = (categories: unknown): string => JSON.stringify({ categories });

  it("matches an entry written as a label or as a code", () => {
    const parsed = parseCadenceConfig(
      config({
        Injectables: { expectedReturnIntervalDays: 120 },
        "laser-resurfacing": { expectedReturnIntervalDays: 365 },
      }),
    );

    expect(parsed.get("injectables")).toMatchObject({ expectedReturnIntervalDays: 120 });
    expect(parsed.get("laser-resurfacing")).toMatchObject({ expectedReturnIntervalDays: 365 });
  });

  it("keeps the operator's spelling as the display for a category revenue never saw", () => {
    const parsed = parseCadenceConfig(
      config({ "Body Contouring": { expectedReturnIntervalDays: 365 } }),
    );

    expect(parsed.get("body-contouring")!.display).toBe("Body Contouring");
  });

  it("accepts a null interval — the category defines no dormancy", () => {
    const parsed = parseCadenceConfig(config({ Garments: { expectedReturnIntervalDays: null } }));

    expect(parsed.get("garments")!.expectedReturnIntervalDays).toBeNull();
  });

  it("accepts an optional hand-set ticket override", () => {
    const parsed = parseCadenceConfig(
      config({ Surgery: { expectedReturnIntervalDays: 730, typicalTicketCents: 850_000 } }),
    );

    expect(parsed.get("surgery")!.typicalTicketCents).toBe(850_000);
  });

  it("rejects an interval that is not a positive whole number of days", () => {
    expect(() =>
      parseCadenceConfig(config({ Injectables: { expectedReturnIntervalDays: 0 } })),
    ).toThrow(ConfigError);
    expect(() =>
      parseCadenceConfig(config({ Injectables: { expectedReturnIntervalDays: 90.5 } })),
    ).toThrow(ConfigError);
  });

  it("rejects a negative ticket override", () => {
    expect(() =>
      parseCadenceConfig(
        config({ Injectables: { expectedReturnIntervalDays: 90, typicalTicketCents: -1 } }),
      ),
    ).toThrow(ConfigError);
  });

  it("rejects two keys that mean the same category", () => {
    expect(() =>
      parseCadenceConfig(
        config({
          Injectables: { expectedReturnIntervalDays: 90 },
          injectables: { expectedReturnIntervalDays: 120 },
        }),
      ),
    ).toThrow(ConfigError);
  });

  it("rejects a file that is not the expected shape", () => {
    expect(() => parseCadenceConfig("not json")).toThrow(ConfigError);
    expect(() => parseCadenceConfig("{}")).toThrow(ConfigError);
    expect(() => parseCadenceConfig(config({ Injectables: 90 }))).toThrow(ConfigError);
    expect(() => parseCadenceConfig(config({ Injectables: {} }))).toThrow(ConfigError);
  });
});
