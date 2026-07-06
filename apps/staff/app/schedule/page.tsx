import { isValidDateString, StaffError, type DaySheet } from "@medibun/api-client";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ScheduleView } from "../components/day-sheet";
import { VIEW_DAYS, type ScheduleView as View } from "../lib/day-sheet";
import { bffClient, sessionCookie } from "../lib/bff";
import { getSessionStaff } from "../lib/session";

export const metadata: Metadata = { title: "Schedule" };

/**
 * Schedule (S5, reworked per docs/SCHEDULE_DESIGN.md). Auth-gated RSC: the session
 * cookie is forwarded server-side to the BFF, which runs every FHIR read as the
 * signed-in staff member's own Medplum principal. URL params (`view`, `date`,
 * `practitioner`) are the state; the BFF Monday-aligns the week range. The interactive
 * grid + toolbar live in the ScheduleView client component.
 */
export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; date?: string; practitioner?: string }>;
}) {
  const params = await searchParams;
  const view: View = params.view === "week" ? "week" : "day";
  // An impossible ?date (hand-edited URL, e.g. 2026-02-31) falls back to today — a bad
  // URL is not an outage, and the BFF would 400 the raw value.
  const requestedDate = params.date && isValidDateString(params.date) ? params.date : undefined;

  // The session probe and the sheet fetch are independent BFF calls — run them
  // together. The sheet's failure is held (not thrown) so the auth redirect still wins.
  const [staff, sheetResult] = await Promise.all([
    getSessionStaff(),
    (async (): Promise<{ sheet: DaySheet } | { error: unknown }> => {
      try {
        const cookie = await sessionCookie();
        return {
          sheet: await bffClient().getDaySheet(
            { date: requestedDate, days: VIEW_DAYS[view] },
            { cookie },
          ),
        };
      } catch (error) {
        return { error };
      }
    })(),
  ]);
  if (!staff) {
    redirect("/login");
  }
  if (
    "error" in sheetResult &&
    sheetResult.error instanceof StaffError &&
    sheetResult.error.code === "unauthorized"
  ) {
    redirect("/login");
  }
  const sheet = "sheet" in sheetResult ? sheetResult.sheet : undefined;
  const failed = !sheet;

  return (
    <div className="mx-auto flex h-full min-h-0 max-w-7xl flex-col px-5 pt-6 pb-4 sm:px-8">
      <section className="shrink-0 pb-4">
        <p className="type-kicker">Front desk</p>
        <h1 className="type-display mt-2 text-3xl text-text-primary">Schedule</h1>
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
        <ScheduleView
          sheet={sheet}
          view={view}
          practitionerId={params.practitioner}
          selfPractitionerId={staff.id}
        />
      )}
    </div>
  );
}
