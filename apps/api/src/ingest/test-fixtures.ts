/**
 * TEST-ONLY synthetic CSV builders for the ingestion suites (same posture as
 * db/test-db.ts). Fixtures are COMPOSED here rather than checked in as literal CSV
 * files: every value is obviously fake and every date is assembled from numeric parts,
 * so no fixture in this repo ever carries a real-looking identity (security.md — test
 * data is synthetic and non-PHI, and the pre-edit tripwires stay meaningful).
 */

const pad = (n: number): string => String(n).padStart(2, "0");

/** ISO calendar date "YYYY-MM-DD", assembled from parts. */
export const ymd = (year: number, month: number, day: number): string =>
  `${year}-${pad(month)}-${pad(day)}`;

/** US-style calendar date "MM/DD/YYYY", assembled from parts. */
export const mdy = (year: number, month: number, day: number): string =>
  `${pad(month)}/${pad(day)}/${year}`;

/** Practice-local wall time "YYYY-MM-DD HH:mm", assembled from parts. */
export const ymdhm = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string => `${ymd(year, month, day)} ${pad(hour)}:${pad(minute)}`;

/** One RFC-4180 cell: quoted only when it must be. */
export const csvCell = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

/** One CSV line from cells. */
export const csvRow = (...cells: readonly string[]): string => cells.map(csvCell).join(",");

/** A whole CSV file: header line + data lines, CRLF-free and newline-terminated. */
export const csvFile = (headers: readonly string[], rows: readonly (readonly string[])[]): string =>
  [csvRow(...headers), ...rows.map((r) => csvRow(...r))].join("\n") + "\n";
