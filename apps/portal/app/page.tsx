import Link from "next/link";

// Server Component (RSC) — the v0 home content for the patient portal. Honest about
// what exists: booking is live (S4); history and the concierge arrive in their own
// slices. Design language via tokens only — no hardcoded brand values, per CLAUDE.md.
export default function Home() {
  const cardClass =
    "block h-full rounded-lg border border-border-hairline bg-surface-card p-6 shadow-low";
  return (
    <div className="mx-auto max-w-4xl px-8 pb-16">
      <section className="pt-12 pb-10">
        <p className="type-kicker">Welcome</p>
        <h1 className="type-display mt-3 max-w-2xl text-4xl text-text-primary">
          Care that feels like a ritual, not a queue.
        </h1>
        <p className="mt-4 max-w-xl text-text-secondary">
          Book a visit, revisit your treatment history, and get answers grounded in your own record
          — all in one calm place.
        </p>
      </section>

      <section aria-label="What you can do here" className="grid gap-4 sm:grid-cols-3">
        <Link
          href="/book"
          className={`${cardClass} transition-shadow hover:shadow-mid focus-visible:ring-2 focus-visible:ring-action-primary focus-visible:outline-none`}
        >
          <h2 className="text-base font-semibold text-text-primary">Book a visit</h2>
          <p className="mt-2 text-sm text-text-secondary">Find a time that fits — no phone tag.</p>
        </Link>
        {[
          { title: "Your history", body: "Every treatment, on your own timeline." },
          { title: "Ask anything", body: "Answers grounded in your record, cited." },
        ].map((card) => (
          <article key={card.title} className={cardClass}>
            <h2 className="text-base font-semibold text-text-primary">{card.title}</h2>
            <p className="mt-2 text-sm text-text-secondary">{card.body}</p>
          </article>
        ))}
      </section>
    </div>
  );
}
