import { tokens } from "@medibun/design-tokens";

// Server Component (RSC). Proves cross-package wiring: imports a token value from the
// shared package and applies brand-token-driven Tailwind utilities that resolve through
// the runtime CSS variables.
export default function Home() {
  return (
    <main className="min-h-screen bg-brand-background text-brand-foreground p-8">
      <h1 className="text-2xl font-semibold text-brand-primary">Aureva Staff</h1>
      <p className="mt-2 text-brand-muted">
        Scaffold online. Brand primary token: <code>{tokens["brand-color-primary"]}</code>
      </p>
    </main>
  );
}
