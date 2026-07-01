import { defineConfig } from "drizzle-kit";

// `generate` reads only schema.ts and needs no DB. DB-connected commands (push/studio)
// get drizzle-kit's own "dbCredentials required" error instead of a blank-URL hang.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  ...(process.env.EXPERIENCE_DATABASE_URL
    ? { dbCredentials: { url: process.env.EXPERIENCE_DATABASE_URL } }
    : {}),
});
