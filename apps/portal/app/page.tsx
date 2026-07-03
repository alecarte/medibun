// Server Component (RSC) — the v0 home content for the patient portal. Static and honest:
// booking, history, and the concierge arrive in their own slices; this page establishes
// the design language (tokens only — no hardcoded brand values, per CLAUDE.md).
export default function Home() {
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
        {[
          { title: "Book a visit", body: "Find a time that fits — no phone tag." },
          { title: "Your history", body: "Every treatment, on your own timeline." },
          { title: "Ask anything", body: "Answers grounded in your record, cited." },
        ].map((card) => (
          <article
            key={card.title}
            className="rounded-lg border border-border-hairline bg-surface-card p-6 shadow-low"
          >
            <h2 className="text-base font-semibold text-text-primary">{card.title}</h2>
            <p className="mt-2 text-sm text-text-secondary">{card.body}</p>
          </article>
        ))}
      </section>
    </div>
  );
}
