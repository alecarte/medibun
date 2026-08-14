import type {
  SourceSystem,
  StagedEntity,
  stagedAppointments,
  stagedConsults,
  stagedInquiries,
  stagedPatients,
  stagedTransactions,
} from "../db/schema.js";

/**
 * The ingestion contract (RECOVERY_DESIGN.md §2): adapters over interoperability. One
 * adapter per source system, built only when an engagement demands it — no FHIR mapping
 * of imports, no universal-connector ambitions. Parsing is PURE and SYNCHRONOUS (no IO,
 * no DB), so every source's quirks are unit-testable without a database and the
 * importer stays the only thing that touches Postgres.
 */

/** The columns an adapter fills; the rest of each staged row belongs to the importer
 *  (id, source system, import id, timestamps) or to a later slice (medplumPatientId). */
type AdapterFields<T, K extends keyof T> = Required<Pick<T, K>>;

export type StagedPatientRow = AdapterFields<
  typeof stagedPatients.$inferInsert,
  "sourceIdentity" | "firstName" | "lastName" | "dob" | "phone" | "email"
>;

export type StagedAppointmentRow = AdapterFields<
  typeof stagedAppointments.$inferInsert,
  | "sourceIdentity"
  | "patientSourceIdentity"
  | "patientName"
  | "dob"
  | "phone"
  | "startAt"
  | "statusRaw"
  | "serviceCategoryRaw"
  | "providerRaw"
>;

export type StagedInquiryRow = AdapterFields<
  typeof stagedInquiries.$inferInsert,
  | "sourceIdentity"
  | "patientSourceIdentity"
  | "occurredAt"
  | "channelRaw"
  | "outcomeRaw"
  | "name"
  | "phone"
>;

export type StagedConsultRow = AdapterFields<
  typeof stagedConsults.$inferInsert,
  | "sourceIdentity"
  | "patientSourceIdentity"
  | "patientName"
  | "consultDate"
  | "serviceCategoryRaw"
  | "outcomeRaw"
  | "providerRaw"
  | "quoteAmountCents"
  | "bookedRaw"
  | "completedRaw"
>;

export type StagedTransactionRow = AdapterFields<
  typeof stagedTransactions.$inferInsert,
  | "sourceIdentity"
  | "patientSourceIdentity"
  | "transactionDate"
  | "serviceCategoryRaw"
  | "amountCents"
>;

export type StagedRowByEntity = {
  patients: StagedPatientRow;
  appointments: StagedAppointmentRow;
  inquiries: StagedInquiryRow;
  consults: StagedConsultRow;
  transactions: StagedTransactionRow;
};

/**
 * One row the adapter would not stage. `reason` is operator-facing and carries the
 * COLUMN name only — never the offending value (PHI discipline, CLAUDE.md); `raw` is
 * the verbatim source line and goes ONLY into the rejects file the CLI writes, never
 * into a log, an error message, or the database.
 */
export type RejectedRow = {
  /** 1-based line the record ends on (a quoted record may span several lines). */
  readonly line: number;
  readonly reason: string;
  readonly raw: string;
};

export type ParseResult<E extends StagedEntity> = {
  /** Validated, trimmed rows with a unique `sourceIdentity` — the importer upserts
   *  them in one statement and relies on that uniqueness. */
  readonly rows: readonly StagedRowByEntity[E][];
  readonly rejects: readonly RejectedRow[];
};

/** The file cannot be staged at all — wrong shape, not a bad row. Carries column names
 *  and parser codes only; never row content. */
export class SourceFileError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SourceFileError";
  }
}

export interface SourceAdapter {
  readonly sourceSystem: SourceSystem;
  /** What this source can produce — `parse` throws SourceFileError for anything else. */
  readonly entities: readonly StagedEntity[];
  /** Pure: same content in, same rows out. Throws SourceFileError on a file-level
   *  problem (missing required column, unparseable CSV); bad rows come back as
   *  rejects so one broken line never costs the whole export. */
  parse<E extends StagedEntity>(entity: E, content: string): ParseResult<E>;
}
