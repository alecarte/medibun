import type { drizzle } from "drizzle-orm/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "./schema.js";
import { bootTestDb } from "./test-db.js";

/**
 * Contract tests for experience-DB tables that no service writes yet — the checked-in
 * migrations are applied by `bootTestDb`, so this is also what proves a new migration
 * lands cleanly on top of its predecessors.
 */

let db: ReturnType<typeof drizzle>;

// One PGlite boot per test file (shared helper); explicit budget for cold CI runners.
beforeAll(async () => {
  db = await bootTestDb();
}, 60_000);

beforeEach(async () => {
  await db.delete(schema.serviceCategories);
});

describe("service_categories (R2)", () => {
  it("takes a category with its financial config unset", async () => {
    await db.insert(schema.serviceCategories).values({ code: "garments", display: "Garments" });

    const [row] = await db.select().from(schema.serviceCategories);
    expect(row).toMatchObject({
      code: "garments",
      display: "Garments",
      // Retail defines no dormancy, and ticket values are seeded later — all nullable.
      expectedReturnIntervalDays: null,
      typicalTicketCents: null,
      ticketBasis: null,
    });
  });

  it("records the interval and the ticket value with the basis it was derived from", async () => {
    await db.insert(schema.serviceCategories).values({
      code: "injectables",
      display: "Injectables",
      expectedReturnIntervalDays: 120,
      typicalTicketCents: 62_500,
      ticketBasis: "revenue-average",
    });

    const [row] = await db.select().from(schema.serviceCategories);
    expect(row).toMatchObject({
      expectedReturnIntervalDays: 120,
      typicalTicketCents: 62_500,
      ticketBasis: "revenue-average",
    });
  });

  it("keeps one row per category code", async () => {
    await db.insert(schema.serviceCategories).values({ code: "surgical", display: "Surgical" });

    await expect(
      db.insert(schema.serviceCategories).values({ code: "surgical", display: "Surgery" }),
    ).rejects.toThrow();
  });
});
