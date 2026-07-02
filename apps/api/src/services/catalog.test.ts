import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createServiceCatalog, type ServiceCatalog } from "./catalog.js";
import * as schema from "../db/schema.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

let catalog: ServiceCatalog;
let db: ReturnType<typeof drizzle>;

const botox = {
  id: "botox-standard",
  code: "svc-botox",
  name: "Botox",
  description: "Neuromodulator treatment, dosed per area.",
  durationMinutes: 30,
  priceCents: 39500,
  categoryColor: "sage",
};

// Same per-file PGlite pattern as sessions.test (explicit budget for cold CI runners).
beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
}, 60_000);

beforeEach(async () => {
  await db.delete(schema.services);
  catalog = createServiceCatalog(db);
});

describe("service catalog", () => {
  it("upserts and lists active services in name order", async () => {
    await catalog.upsert({ ...botox, name: "Botox" });
    await catalog.upsert({ ...botox, id: "dysport", code: "svc-dysport", name: "Dysport" });
    const rows = await catalog.listActive();
    expect(rows.map((r) => r.name)).toEqual(["Botox", "Dysport"]);
  });

  it("hides inactive services from the menu but keeps them addressable by code", async () => {
    await catalog.upsert({ ...botox, active: false });
    await expect(catalog.listActive()).resolves.toEqual([]);
    await expect(catalog.getByCode("svc-botox")).resolves.toMatchObject({ id: "botox-standard" });
  });

  it("re-upserting the same id updates in place (idempotent seed)", async () => {
    await catalog.upsert(botox);
    await catalog.upsert({ ...botox, priceCents: 42000, healthcareServiceId: "hs-1" });
    const row = await catalog.getByCode("svc-botox");
    expect(row?.priceCents).toBe(42000);
    expect(row?.healthcareServiceId).toBe("hs-1");
    await expect(catalog.listActive()).resolves.toHaveLength(1);
  });

  it("resolves undefined for an unknown code", async () => {
    await expect(catalog.getByCode("svc-nope")).resolves.toBeUndefined();
  });
});
