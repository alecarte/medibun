import { tokens } from "@medibun/design-tokens";

// Server Component (RSC) — the v0 shell for the staff app, in the Thermae work register:
// compact, paper-on-linen, hairlines instead of grey borders. The day sheet fills with the
// booking + check-in slices; this page establishes the language (tokens only, no hardcoded
// brand values, per CLAUDE.md).
export default function Home() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <span className="text-sm font-medium text-text-secondary">
          <span className="type-display text-lg text-brand-primary">{tokens["brand-name"]}</span>
          <span className="ml-2">Staff</span>
        </span>
        <span className="rounded-full bg-action-primary px-4 py-1.5 text-sm font-medium text-text-on-accent">
          Sign in
        </span>
      </header>

      <main className="mx-auto max-w-6xl px-6 pb-16">
        <section className="pt-8 pb-6">
          <p className="type-kicker">Front desk</p>
          <h1 className="type-display mt-2 text-4xl text-text-primary">Today</h1>
        </section>

        <section
          aria-label="Day sheet"
          className="rounded-lg border border-border-hairline bg-surface-card"
        >
          <div className="flex items-center justify-between border-b border-border-hairline px-5 py-3">
            <span className="text-sm font-medium text-text-primary">Schedule</span>
            <div className="flex gap-2" aria-hidden="true">
              <span className="status-chip bg-status-success-wash text-status-success-text">
                Checked in
              </span>
              <span className="status-chip bg-status-info-wash text-status-info-text">Booked</span>
              <span className="status-chip bg-status-warning-wash text-status-warning-text">
                Running late
              </span>
            </div>
          </div>
          <p className="px-5 py-10 text-sm text-text-secondary">
            No appointments yet — the day sheet fills when online booking lands.
          </p>
        </section>
      </main>
    </div>
  );
}
