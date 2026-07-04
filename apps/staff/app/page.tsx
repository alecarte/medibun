import { StaffError, type DaySheet } from "@medibun/api-client";
import { redirect } from "next/navigation";

import { DaySheetView } from "./components/day-sheet";
import { bffClient, sessionCookie } from "./lib/bff";
import { formatDateHeading } from "./lib/day-sheet";
import { getSessionStaff } from "./lib/session";

/**
 * Today — the staff day sheet (S5). Auth-gated RSC: the session cookie is forwarded
 * server-side to the BFF, which runs every FHIR read as the signed-in staff member's
 * own Medplum principal (AccessPolicy + audit attribution at the core).
 */
export default async function TodayPage() {
  const staff = await getSessionStaff();
  if (!staff) {
    redirect("/login");
  }

  let sheet: DaySheet | undefined;
  let failed = false;
  try {
    const cookie = await sessionCookie();
    sheet = await bffClient().getDaySheet({ cookie });
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
          <h1 className="type-display mt-2 text-3xl text-text-primary">Today</h1>
        </div>
        {sheet && (
          <p className="text-sm text-text-secondary tabular-nums">
            {formatDateHeading(sheet.date)} ·{" "}
            {sheet.appointments.length === 1
              ? "1 appointment"
              : `${sheet.appointments.length} appointments`}
          </p>
        )}
      </section>

      {failed || !sheet ? (
        <section
          aria-label="Day sheet unavailable"
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
