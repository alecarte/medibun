import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { getAvailability, getServices } from "../../lib/booking";
import { getSessionProfile } from "../../lib/session";
import { formatDuration, formatPrice } from "../../lib/slots";
import { CATEGORY_DOT } from "../category";
import { BookingFlow } from "./booking-flow";

export const metadata: Metadata = { title: "Pick a time" };

// Booking step 2 (S4): pick a practitioner and time for one service. Availability is
// server-fetched ($find fan-out in the BFF); the interactive picking + booking is the
// BookingFlow client island.
export default async function ServiceBookingPage({
  params,
}: {
  readonly params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  // All three are independent cookie-forwarded BFF reads — start them together;
  // signed-out reads resolve to their benign sentinels and the redirect wins.
  const [profile, services, availability] = await Promise.all([
    getSessionProfile(),
    getServices(),
    getAvailability(code),
  ]);
  if (!profile) {
    redirect("/login");
  }
  if (availability === "not_found") {
    notFound();
  }
  const service = services?.find((s) => s.code === code);

  return (
    <div className="mx-auto max-w-4xl px-8 pb-16">
      <section className="pt-12 pb-8">
        <Link href="/book" className="text-sm text-text-secondary hover:text-text-primary">
          ← All services
        </Link>
        {service ? (
          <>
            <div className="mt-6 flex items-center gap-2.5">
              <span
                aria-hidden
                className={`h-2 w-2 rounded-full ${CATEGORY_DOT[service.categoryColor]}`}
              />
              <p className="type-kicker">Book a visit · Step 2 of 3</p>
            </div>
            <h1 className="type-display mt-3 text-3xl text-text-primary">{service.name}</h1>
            <p className="mt-3 max-w-xl text-sm text-text-secondary">
              {service.description}{" "}
              <span className="tabular-nums">
                {formatDuration(service.durationMinutes)} · {formatPrice(service.priceCents)}
              </span>
            </p>
          </>
        ) : (
          <h1 className="type-display mt-6 text-3xl text-text-primary">Pick a time</h1>
        )}
      </section>

      {availability === undefined || !service ? (
        <p role="alert" className="max-w-md text-sm text-text-secondary">
          We couldn't load open times. Refresh to try again.
        </p>
      ) : (
        // The window start is pinned server-side so the 7-day strip hydrates identically.
        <BookingFlow
          service={service}
          availability={availability}
          windowStartIso={new Date().toISOString()}
        />
      )}
    </div>
  );
}
