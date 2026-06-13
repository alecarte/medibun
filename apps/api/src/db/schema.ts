import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
