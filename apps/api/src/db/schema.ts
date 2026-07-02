import { boolean, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Experience DB schema (ADR-0002). Sessions hold ENCRYPTED Medplum tokens
 * (AES-256-GCM, key in the secret manager — see docs/AUTH.md): a database dump
 * must not yield usable credentials. No clinical data lives here, ever.
 */

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey(),
  /** e.g. "Patient/abc" — the authenticated principal's Medplum profile. */
  profileReference: text("profile_reference").notNull(),
  medplumLoginId: text("medplum_login_id").notNull(),
  accessTokenEnc: text("access_token_enc").notNull(),
  refreshTokenEnc: text("refresh_token_enc"),
  accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

/**
 * The Aureva service menu (DATA_MODEL.md: "service menu lives in the experience DB").
 * Commercial catalog only — names, durations, prices, presentation. NO PHI. Price never
 * enters FHIR; the clinical side references `code` (CodeSystem
 * https://medibun.com/fhir/CodeSystem/services) and `healthcareServiceId` reconciles with
 * the FHIR HealthcareService that carries the Medplum SchedulingParameters (S3, A2).
 */
export const services = pgTable("services", {
  /** Stable slug, e.g. "botox-standard". */
  id: text("id").primaryKey(),
  /** Code in https://medibun.com/fhir/CodeSystem/services — the FHIR reconciliation key. */
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  priceCents: integer("price_cents").notNull(),
  /** Categorical color token key (design-tokens color.category.*), e.g. "sage". */
  categoryColor: text("category_color").notNull(),
  /** FHIR HealthcareService id (set once seeded/created in Medplum). */
  healthcareServiceId: text("healthcare_service_id"),
  /** Stripe product/price ids arrive with the commerce phase — nullable by design. */
  stripeProductId: text("stripe_product_id"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    /** Client IP only — never an email or other identifier (rate limiting, not tracking). */
    ip: text("ip").notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("login_attempts_ip_time_idx").on(t.ip, t.attemptedAt)],
);
