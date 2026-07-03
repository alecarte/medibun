import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getServices } from "../lib/booking";
import { getSessionProfile } from "../lib/session";
import { formatDuration, formatPrice } from "../lib/slots";
import { CATEGORY_DOT } from "./category";

export const metadata: Metadata = { title: "Book a visit" };

// Booking step 1 (S4): discover services. RSC — the menu is server-fetched per request;
// picking a service navigates to its availability page.
export default async function BookPage() {
  const profile = await getSessionProfile();
  if (!profile) {
    redirect("/login");
  }
  const services = await getServices();

  return (
    <div className="mx-auto max-w-4xl px-8 pb-16">
      <section className="pt-12 pb-8">
        <p className="type-kicker">Book a visit</p>
        <h1 className="type-display mt-3 text-3xl text-text-primary">What brings you in?</h1>
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
        <ul aria-label="Services" className="grid gap-4 sm:grid-cols-2">
          {services.map((service) => (
            <li key={service.code}>
              <Link
                href={`/book/${service.code}`}
                className="block rounded-lg border border-border-hairline bg-surface-card p-6 shadow-low transition-shadow hover:shadow-mid focus-visible:ring-2 focus-visible:ring-action-primary focus-visible:outline-none"
              >
                <div className="flex items-center gap-2.5">
                  <span aria-hidden className={`h-2 w-2 rounded-full ${CATEGORY_DOT[service.categoryColor]}`} />
                  <h2 className="text-base font-semibold text-text-primary">{service.name}</h2>
                </div>
                <p className="mt-2 text-sm text-text-secondary">{service.description}</p>
                <p className="mt-4 text-sm text-text-secondary tabular-nums">
                  {formatDuration(service.durationMinutes)} · {formatPrice(service.priceCents)}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
