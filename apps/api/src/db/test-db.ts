import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import * as schema from "./schema.js";

/**
 * Test-only PGlite boot applying the REAL checked-in migrations (drizzle/) so tests and
 * prod share one schema definition. One boot per test FILE (see callers' beforeAll with
 * an explicit generous timeout — a cold CI runner can exceed vitest's 10s default);
 * isolate tests by wiping rows, not re-booting.
 */
export async function bootTestDb() {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
  });
  return db;
}
