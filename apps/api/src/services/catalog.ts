import { asc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { services } from "../db/schema.js";

/** Commercial service row (experience DB). No PHI — catalog data only. */
export type ServiceRow = typeof services.$inferSelect;
export type ServiceInsert = typeof services.$inferInsert;

// Same driver-agnostic shape as sessions.ts: node-postgres in prod, PGlite in tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<PgQueryResultHKT, any, any>;

/**
 * The service catalog (DATA_MODEL.md: service menu lives in the experience DB).
 * Read paths feed the booking UI; upsert exists for the demo seed and (later) admin.
 */
export function createServiceCatalog(db: Db) {
  return {
    /** Active services in stable menu order (by name). */
    async listActive(): Promise<ServiceRow[]> {
      return db
        .select()
        .from(services)
        .where(eq(services.active, true))
        .orderBy(asc(services.name));
    },

    /** A single service by its FHIR CodeSystem code, active or not. */
    async getByCode(code: string): Promise<ServiceRow | undefined> {
      const rows = await db.select().from(services).where(eq(services.code, code)).limit(1);
      return rows[0];
    },

    /** Idempotent seed/admin upsert keyed by id (slug). */
    async upsert(row: ServiceInsert): Promise<void> {
      await db
        .insert(services)
        .values(row)
        .onConflictDoUpdate({
          target: services.id,
          set: {
            code: row.code,
            name: row.name,
            description: row.description,
            durationMinutes: row.durationMinutes,
            priceCents: row.priceCents,
            categoryColor: row.categoryColor,
            healthcareServiceId: row.healthcareServiceId ?? null,
            stripeProductId: row.stripeProductId ?? null,
            active: row.active ?? true,
          },
        });
    },
  };
}

export type ServiceCatalog = ReturnType<typeof createServiceCatalog>;
