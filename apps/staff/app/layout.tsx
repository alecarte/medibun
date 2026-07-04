import type { Metadata } from "next";
import { Instrument_Sans } from "next/font/google";
import { tokens } from "@medibun/design-tokens";
import { cookies } from "next/headers";
import { Sidebar } from "./components/sidebar";
import { COLLAPSE_COOKIE } from "./lib/prefs";
import "./globals.css";

const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument-sans",
});

export const metadata: Metadata = {
  title: `${tokens["brand-name"]} Staff`,
  description: "Practitioner and front-desk app for the Aureva / Handal platform.",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Collapse preference is a cookie so the FIRST paint is already collapsed/expanded —
  // no post-hydration flash or layout shift (same pattern as the portal shell).
  const cookieStore = await cookies();
  const collapsed = cookieStore.get(COLLAPSE_COOKIE)?.value === "1";
  // `data-brand` is the runtime-theming seam: the settings GUI / per-tenant resolution
  // sets it server-side, and the [data-brand] CSS-variable scope swaps the brand with no rebuild.
  return (
    <html lang="en" data-brand="aureva" className={instrumentSans.variable}>
      <body className="antialiased">
        {/* Mobile-first: the shell stacks (top bar over content) below md and becomes
            rail + content beside each other from md up. */}
        <div className="flex min-h-screen flex-col md:flex-row">
          <Sidebar initialCollapsed={collapsed} />
          <main className="flex-1">{children}</main>
        </div>
      </body>
    </html>
  );
}
