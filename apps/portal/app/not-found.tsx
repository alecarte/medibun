import Link from "next/link";

// Designed not-found state (DESIGN.md tenet 5: never a defaulted error screen).
// First reachable via booking's unknown-service notFound() (S4).
export default function NotFound() {
  return (
    <div className="mx-auto max-w-2xl px-8">
      <section className="pt-12 pb-8">
        <p className="type-kicker">Not found</p>
        <h1 className="type-display mt-3 text-3xl text-text-primary">
          That page isn't here.
        </h1>
        <p className="mt-4 max-w-md text-sm text-text-secondary">
          The link may be old, or the page may not exist yet.
        </p>
        <Link
          href="/"
          className="mt-8 inline-block rounded-control bg-action-primary px-5 py-2 text-sm font-medium text-text-on-accent"
        >
          Back to home
        </Link>
      </section>
    </div>
  );
}
