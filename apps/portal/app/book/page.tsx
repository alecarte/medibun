import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getServices } from "../lib/booking";
import { getSessionProfile } from "../lib/session";
import { formatDuration, formatPrice } from "../lib/slots";
import { CATEGORY_WASH } from "./category";

export const metadata: Metadata = { title: "Book a visit" };

// Booking step 1 (S4.5, BOOKING_DESIGN.md §3): discover services in the premium
// register. RSC — the menu is server-fetched per request. Designed seams (rev. 3),
// populated by later slices: a "Book your usual" fast path renders here once history
// endpoints exist (S9); the "for you" recommendation rail lands with the growth
// engine (Phase 2); the concierge "Not sure? Ask us" affordance lands with S10.
export default async function BookPage() {
  // Independent BFF reads — one round-trip time, not two; a signed-out visitor's
  // menu read just resolves undefined and the redirect wins.
  const [profile, services] = await Promise.all([getSessionProfile(), getServices()]);
  if (!profile) {
    redirect("/login");
  }

  return (
    <div className="mx-auto max-w-4xl px-5 pb-16 sm:px-8">
      <section className="pt-12 pb-8">
        <p className="type-kicker">Book a visit · Step 1 of 3</p>
        <h1 className="type-display mt-3 text-3xl text-text-primary">What brings you in?</h1>
        <p className="mt-3 max-w-xl text-sm text-text-secondary">
          Every visit starts with a conversation — your injector confirms the plan with you in the
          room.
        </p>
      </section>

      {services === undefined ? (
        <p role="alert" className="max-w-md text-sm text-text-secondary">
          We couldn't load the service menu. Refresh to try again.
        </p>
      ) : services.length === 0 ? (
        <p className="max-w-md text-sm text-text-secondary">
          Nothing is bookable online yet. Check back soon.
        </p>
      ) : (
        <ul aria-label="Services" className="grid gap-5 sm:grid-cols-2">
          {services.map((service) => (
            <li key={service.code}>
              <Link
                href={`/book/${service.code}`}
                className="block overflow-hidden rounded-lg border border-border-hairline bg-surface-card shadow-low transition-shadow hover:shadow-mid focus-visible:ring-2 focus-visible:ring-action-primary focus-visible:outline-none"
              >
                {/* Photography-ready media panel — a token wash until brand assets land. */}
                <span
                  aria-hidden
                  className={`block h-28 ${CATEGORY_WASH[service.categoryColor]}`}
                />
                <span className="block p-5">
                  <span className="flex items-baseline justify-between gap-3">
                    <h2 className="text-base font-semibold text-text-primary">{service.name}</h2>
                    <span className="text-sm font-semibold text-text-primary tabular-nums">
                      {formatPrice(service.priceCents)}
                    </span>
                  </span>
                  <span className="mt-1.5 block text-sm text-text-secondary">
                    {service.description}
                  </span>
                  <span className="mt-4 flex items-center justify-between">
                    <span className="text-sm text-text-secondary tabular-nums">
                      {formatDuration(service.durationMinutes)}
                    </span>
                    <span className="text-sm font-medium text-brand-primary">See times →</span>
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
