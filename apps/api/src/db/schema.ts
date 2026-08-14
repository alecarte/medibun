import type { CategoryColor } from "@medibun/design-tokens";
import { sql } from "drizzle-orm";
import {
  boolean,
  date,
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

/**
 * Recovery ingestion (R1, RECOVERY_DESIGN.md §2–3). Source systems we can stage from;
 * one adapter per member. Widening this union is what adding an adapter looks like.
 */
export type SourceSystem = "4d";

/** The entities a source adapter can produce — one staging table each. */
export type StagedEntity = "patients" | "appointments" | "inquiries" | "consults" | "transactions";

/**
 * Append-only import run ledger: one row per (file, entity) import run, written even
 * when nothing changed. This is the reconciliation evidence behind every attribution
 * claim ("which export, which counts, when"). NO PHI: `fileName` and `rejectsUri` are
 * basenames only — never paths, because a directory a human chose can itself name a
 * patient. The rejects FILE holds raw rows; this table holds counts and names only.
 */
export const imports = pgTable("imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceSystem: text("source_system").$type<SourceSystem>().notNull(),
  entity: text("entity").$type<StagedEntity>().notNull(),
  /** Basename of the imported file — never a filesystem path. */
  fileName: text("file_name").notNull(),
  /** sha256 of the file content: the same export re-imported is provably the same bytes. */
  fileHash: text("file_hash").notNull(),
  /** Data rows read from the file (header excluded) = stagedCount + rejectedCount. */
  rowCount: integer("row_count").notNull(),
  stagedCount: integer("staged_count").notNull(),
  rejectedCount: integer("rejected_count").notNull(),
  /** Basename of the rejects file the run wrote; null when the run was clean. */
  rejectsUri: text("rejects_uri"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Staged patient roster (R1, amended R2a). PHI — administrative identity + contact +
 * FINANCIAL history only (name, date of birth, phone + its type, email, lifetime spend);
 * no clinical content ever enters the experience DB (RECOVERY_DESIGN.md §3, the
 * two-store rule). The export's address columns are deliberately NOT staged — the engine
 * never mails anyone, so they are data we would hold for nothing (R0, data minimization).
 * Values are staged verbatim after trim;
 * normalization is a later concern. `(source_system, source_identity)` is the
 * idempotency key: a re-import reconciles onto the existing row.
 */
export const stagedPatients = pgTable(
  "staged_patients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Untyped text (not the `SourceSystem` union) on purpose: staged rows from a
     *  retired adapter must stay readable after its union member is removed. */
    sourceSystem: text("source_system").notNull(),
    /** The source system's own patient id — the reconciliation key across imports. */
    sourceIdentity: text("source_identity").notNull(),
    /** The last import run that wrote this row. */
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id),
    firstName: text("first_name"),
    lastName: text("last_name"),
    dob: date("dob"),
    phone: text("phone"),
    /** "Mobile" / "Home" / … verbatim — R5 needs to know which number can take an SMS
     *  (R2a). Nothing reads it before then. */
    phoneType: text("phone_type"),
    email: text("email"),
    /** The export's per-patient HISTORICAL spend — financial, not clinical: it weights
     *  the dormant pool by value (R2a). Never a running balance we maintain. */
    spendCents: integer("spend_cents"),
    /** Medplum Patient id once identity is promoted — UNUSED in R1 (promotion and the
     *  manual-merge queue land before R5 enrollment; the link column exists now so the
     *  staging table never needs a second migration for it). */
    medplumPatientId: text("medplum_patient_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("staged_patients_source_idx").on(t.sourceSystem, t.sourceIdentity)],
);

/**
 * Staged appointment history (R1, corrected R2a) — the dormant pool's "no future
 * booking" half. PHI-adjacent: times, status, and the source's raw service
 * category/provider labels, never what was treated. The real 4D export (R0) carries
 * **neither a patient id nor a status column**, so both are nullable and the roster join
 * runs on `patientName` + `dob` + `phone`; `patientSourceIdentity` stays for sources that
 * do carry one and joins staging-side with NO foreign key on purpose: an export may name
 * patients missing from the roster it shipped, and segmentation treats those as degraded
 * rows rather than losing them at import. The export's **Allergy** (clinical) and
 * **Description** (operator free text that can carry a visit reason) columns have no
 * column here by construction — the adapter drops them on read (R0, two-store rule).
 * `startAt` is parsed from the source's practice-local wall time (unparseable → the
 * row is rejected, never silently coerced).
 */
export const stagedAppointments = pgTable(
  "staged_appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceSystem: text("source_system").notNull(),
    /** The source's own row id where it has one; where it does not (4D's appointment
     *  export), the ADAPTER derives it — sha256 of the row's normalized identifying
     *  fields plus an occurrence suffix that separates true duplicates — so re-import
     *  stays idempotent by `(source_system, source_identity)`. */
    sourceIdentity: text("source_identity").notNull(),
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id),
    /** Staging-side join key to `staged_patients.source_identity` (no FK by design);
     *  null when the export carries no patient id — then the three columns below are
     *  the join. */
    patientSourceIdentity: text("patient_source_identity"),
    /** Roster join keys for an export with no patient id (R0: name + DOB + phone). */
    patientName: text("patient_name"),
    dob: date("dob"),
    phone: text("phone"),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    /** Source labels, verbatim — R2 owns mapping raw categories to service_categories.
     *  `statusRaw` is nullable: 4D's export has no status column (R0), which is why
     *  dormancy computes primarily from paid revenue rows instead. */
    statusRaw: text("status_raw"),
    serviceCategoryRaw: text("service_category_raw"),
    providerRaw: text("provider_raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("staged_appointments_source_idx").on(t.sourceSystem, t.sourceIdentity)],
);

/**
 * Staged inbound inquiries (R1) — the missed-inquiry pool's input. PHI (contact only):
 * an inquirer may never have become a patient, so `patientSourceIdentity` is nullable
 * and a name/phone may be all we have. Columns are PROVISIONAL until R0 records the
 * real 4D field mapping (RECOVERY_DESIGN.md §2); adjustments are a follow-up migration
 * at the same gate.
 */
export const stagedInquiries = pgTable(
  "staged_inquiries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceSystem: text("source_system").notNull(),
    sourceIdentity: text("source_identity").notNull(),
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id),
    /** Null when the inquirer was never matched to a patient record. */
    patientSourceIdentity: text("patient_source_identity"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    channelRaw: text("channel_raw"),
    outcomeRaw: text("outcome_raw"),
    name: text("name"),
    phone: text("phone"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("staged_inquiries_source_idx").on(t.sourceSystem, t.sourceIdentity)],
);

/**
 * Staged consult outcomes (R1, corrected R2a) — the unconverted-consult pool's input,
 * sourced from 4D's Conversion By Provider export. PHI-adjacent: when the consult
 * happened, who the patient is by NAME, the quoted dollars, and the source's raw
 * category/outcome labels — never the clinical content of the consult.
 *
 * R0's correction, in three parts: the export carries **no patient id** (name only, with
 * no DOB or phone to disambiguate it), so `patientSourceIdentity` is null at import and
 * the name-join runs at QUERY time where an ambiguous match is flagged for a human,
 * never guessed; it carries a **date, not a time**; and `booked`/`completed` are staged
 * as the source's own labels because their semantics (what "completed" counts) belong to
 * the R2 pool queries, not to ingestion.
 */
export const stagedConsults = pgTable(
  "staged_consults",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceSystem: text("source_system").notNull(),
    /** 4D's quote number (R0) — the row's stable identity across re-imports. */
    sourceIdentity: text("source_identity").notNull(),
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id),
    /** Null at import for a source with no patient id; filled only by a resolved join. */
    patientSourceIdentity: text("patient_source_identity"),
    /** The only join key this export gives us — hence NOT NULL. */
    patientName: text("patient_name").notNull(),
    /** A date, not an instant: the export carries no time of day. */
    consultDate: date("consult_date").notNull(),
    serviceCategoryRaw: text("service_category_raw"),
    outcomeRaw: text("outcome_raw"),
    providerRaw: text("provider_raw"),
    /** The quoted price — the unconverted pool is valued in ACTUAL quoted dollars
     *  rather than category averages (R0). */
    quoteAmountCents: integer("quote_amount_cents"),
    /** Source labels verbatim; R2 decides what they mean for conversion. */
    bookedRaw: text("booked_raw"),
    completedRaw: text("completed_raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("staged_consults_source_idx").on(t.sourceSystem, t.sourceIdentity)],
);

/**
 * Staged revenue rows (PROPOSED at the R2a walkthrough — RECOVERY_DESIGN.md §3).
 * Dormancy computes primarily from the **last PAID visit per patient per category**
 * (R0), which makes the revenue export the dormant pool's primary signal rather than a
 * one-off average to be computed and thrown away — so it has to be queryable in staging.
 * The earlier "compute averages locally, no new table" note predates that finding; this
 * table is the decision point Alec walks.
 *
 * Administrative + financial ONLY. There is deliberately **no line-item description
 * column**: the export's description is operator-typed and can carry visit-reason-
 * adjacent text, and the math needs only category + amount + date. Excluding it by
 * construction is the two-store rule doing its job (same posture as the appointment
 * export's Allergy/Description columns).
 */
export const stagedTransactions = pgTable(
  "staged_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceSystem: text("source_system").notNull(),
    /** DERIVED — the Revenue CSV has no row id. The adapter computes it: sha256 of the
     *  row's normalized identifying fields (patient, date, category, amount) plus an
     *  occurrence suffix so a patient legitimately charged the same amount twice in a
     *  day stages as two rows. Deriving it in the adapter is what keeps re-import
     *  idempotent by `(source_system, source_identity)`. */
    sourceIdentity: text("source_identity").notNull(),
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id),
    /** The Revenue export DOES carry a patient id (R0) — dormancy joins by id, no name
     *  matching. Nullable because the export also carries non-patient rows. */
    patientSourceIdentity: text("patient_source_identity"),
    /** A date, not an instant: the export carries dates (DOS / paid date). */
    transactionDate: date("transaction_date").notNull(),
    serviceCategoryRaw: text("service_category_raw"),
    /** Negative is legitimate — a refund is a real row, not a bad one. */
    amountCents: integer("amount_cents").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("staged_transactions_source_idx").on(t.sourceSystem, t.sourceIdentity)],
);

/**
 * Service categories (R2, RECOVERY_DESIGN.md §3) — the financial + cadence config the
 * segmentation and Leak Report math run on. NOT staging: nothing imports into it, and it
 * holds no patient data at all. `code` is normalized from 4D's own coded Category
 * taxonomy (a slug of the label), `display` keeps the source label verbatim.
 */
export const serviceCategories = pgTable("service_categories", {
  /** Slug of the source category label, e.g. "injectables". */
  code: text("code").primaryKey(),
  /** The source's label, verbatim — what the Leak Report prints. */
  display: text("display").notNull(),
  /** How long after a visit this category is considered lapsed. HAND-SET clinical-
   *  cadence judgment, never derived from the data (R1 review log). Null = the category
   *  defines no dormancy at all (retail, garments) and is excluded from the pool. */
  expectedReturnIntervalDays: integer("expected_return_interval_days"),
  /** Expected value of one recovered visit in this category; null until seeded. */
  typicalTicketCents: integer("typical_ticket_cents"),
  /** How that ticket value was arrived at — printed as the report's methodology note,
   *  because a number whose basis isn't stated isn't evidence. */
  ticketBasis: text("ticket_basis").$type<"revenue-average" | "list-price" | "hand-set">(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
