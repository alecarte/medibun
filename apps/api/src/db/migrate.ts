import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

/** Apply checked-in SQL migrations (drizzle/) to the experience DB. Dev + CI/CD only — never run by hand against prod (CLAUDE.md). */
async function main(): Promise<void> {
  const url = process.env.EXPERIENCE_DATABASE_URL;
  if (!url) {
    throw new Error("EXPERIENCE_DATABASE_URL is not set (see infra/medplum/.env.example)");
  }
  const pool = new pg.Pool({ connectionString: url });
  await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
  await pool.end();
  console.log(JSON.stringify({ msg: "experience db migrated" }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
