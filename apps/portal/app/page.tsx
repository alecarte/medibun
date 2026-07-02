import { tokens } from "@medibun/design-tokens";

// Server Component (RSC) — the v0 shell for the patient portal. Static and honest:
// booking, history, and the concierge arrive in their own slices; this page establishes
// the design language (tokens only — no hardcoded brand values, per CLAUDE.md).
export default function Home() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <span className="type-display text-2xl text-brand-primary">{tokens["brand-name"]}</span>
        <span className="rounded-full bg-action-primary px-5 py-2 text-sm font-medium text-text-on-accent">
          Sign in
        </span>
      </header>

      <main className="mx-auto max-w-5xl px-6 pb-16">
        <section className="pt-14 pb-12">
          <p className="type-kicker">Welcome</p>
          <h1 className="type-display mt-3 max-w-2xl text-5xl text-text-primary">
            Care that feels like a ritual, not a queue.
          </h1>
          <p className="mt-5 max-w-xl text-lg text-text-secondary">
            Book a visit, revisit your treatment history, and get answers grounded in your own
            record — all in one calm place.
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
              <h2 className="type-display text-xl text-text-primary">{card.title}</h2>
              <p className="mt-2 text-sm text-text-secondary">{card.body}</p>
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}
