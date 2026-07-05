import { StaffError, type DaySheet } from "@medibun/api-client";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { DaySheetView } from "../components/day-sheet";
import { ChevronLeftIcon, ChevronRightIcon } from "../components/icons";
import { bffClient, sessionCookie } from "../lib/bff";
import { formatDateHeading } from "../lib/day-sheet";
import { getSessionStaff } from "../lib/session";

export const metadata: Metadata = { title: "Schedule" };

/** YYYY-MM-DD ± n days, pure calendar math (no timezone involved). */
function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** Loose gate for the ?date= param; the BFF re-validates and 400s anything else. */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Schedule — the practitioner-column day calendar (S5). Auth-gated RSC: the session
 * cookie is forwarded server-side to the BFF, which runs every FHIR read as the
 * signed-in staff member's own Medplum principal (AccessPolicy + audit at the core).
 * Day switching is plain links (?date=…); weekly/monthly views are their own slice.
 */
export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const staff = await getSessionStaff();
  if (!staff) {
    redirect("/login");
  }
  const params = await searchParams;
  const requestedDate = params.date && DATE_SHAPE.test(params.date) ? params.date : undefined;

  let sheet: DaySheet | undefined;
  let failed = false;
  try {
    const cookie = await sessionCookie();
    sheet = await bffClient().getDaySheet(requestedDate, { cookie });
  } catch (err) {
    if (err instanceof StaffError && err.code === "unauthorized") {
      redirect("/login");
    }
    // Designed error state below — the shell (and /login) must keep working.
    failed = true;
  }

  return (
    <div className="mx-auto max-w-7xl px-5 pb-16 sm:px-8">
      <section className="flex flex-wrap items-end justify-between gap-3 pt-8 pb-6">
        <div>
          <p className="type-kicker">Front desk</p>
          <h1 className="type-display mt-2 text-3xl text-text-primary">Schedule</h1>
        </div>
        {sheet && (
          <div className="flex items-center gap-2">
            <p className="mr-2 text-sm text-text-secondary tabular-nums">
              {formatDateHeading(sheet.date)} ·{" "}
              {sheet.appointments.length === 1
                ? "1 appointment"
                : `${sheet.appointments.length} appointments`}
            </p>
            <Link
              href={`/schedule?date=${shiftDate(sheet.date, -1)}`}
              aria-label="Previous day"
              className="rounded-control border border-border-interactive p-1.5 text-text-secondary hover:bg-surface-well"
            >
              <ChevronLeftIcon className="h-4 w-4" />
            </Link>
            {requestedDate && (
              <Link
                href="/schedule"
                className="rounded-control border border-border-interactive px-3 py-1.5 text-sm text-text-primary hover:bg-surface-well"
              >
                Today
              </Link>
            )}
            <Link
              href={`/schedule?date=${shiftDate(sheet.date, 1)}`}
              aria-label="Next day"
              className="rounded-control border border-border-interactive p-1.5 text-text-secondary hover:bg-surface-well"
            >
              <ChevronRightIcon className="h-4 w-4" />
            </Link>
          </div>
        )}
      </section>

      {failed || !sheet ? (
        <section
          aria-label="Schedule unavailable"
          className="rounded-lg border border-border-hairline bg-surface-card px-5 py-10"
        >
          <p className="text-sm font-medium text-text-primary">The schedule couldn&apos;t load.</p>
          <p className="mt-1 text-sm text-text-secondary">
            Check that the backend is running, then reload this page.
          </p>
        </section>
      ) : (
        <DaySheetView sheet={sheet} />
      )}
    </div>
  );
}
