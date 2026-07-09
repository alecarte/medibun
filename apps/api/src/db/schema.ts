import type { CategoryColor } from "@medibun/design-tokens";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

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
  /** Categorical color token key (design-tokens color.category.*), e.g. "sage" —
   *  typed against the package's exported union so a token rename fails typecheck here. */
  categoryColor: text("category_color").$type<CategoryColor>().notNull(),
  /** FHIR HealthcareService id (set once seeded/created in Medplum). */
  healthcareServiceId: text("healthcare_service_id"),
  /** Stripe product/price ids arrive with the commerce phase — nullable by design. */
  stripeProductId: text("stripe_product_id"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The move-up list (S5.7): patients who want an earlier slot than the appointment they
 * hold — the desk works it when a cancellation frees time. EXPERIENCE DATA, ids only:
 * names/phones are resolved live from FHIR by the BFF as the caller; nothing PHI-shaped
 * is stored here (the sanctioned reconcile-by-id pattern, DATA_MODEL.md). `note` is
 * non-PHI by rule — availability quirks only, same rule as internal-event titles.
 * Phase-2 seam: a Bot on Appointment?status=cancelled auto-matches `waiting` rows.
 */
export const moveUpRequests = pgTable(
  "move_up_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Medplum Patient id — the reconciliation key. */
    patientId: text("patient_id").notNull(),
    /** The later appointment they hold; fulfilling = rescheduling THIS earlier. */
    appointmentId: text("appointment_id").notNull(),
    /** Denormalized from the appointment for match filtering (our CodeSystem code). */
    serviceCode: text("service_code").notNull(),
    /** Preferred practitioner (Medplum Practitioner id); null = any qualified. */
    practitionerId: text("practitioner_id"),
    /** ≤120 chars (MAX_MOVE_UP_NOTE_LENGTH), non-PHI by rule. */
    note: text("note"),
    status: text("status").$type<"waiting" | "fulfilled" | "removed">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    // One WAITING entry per appointment (resolved history may repeat).
    uniqueIndex("move_up_waiting_per_appointment_idx")
      .on(t.appointmentId)
      .where(sql`${t.status} = 'waiting'`),
    // The list reads oldest-first (fairness) over waiting rows.
    index("move_up_status_created_idx").on(t.status, t.createdAt),
  ],
);

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
