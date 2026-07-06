import type { Metadata } from "next";
import { Instrument_Sans } from "next/font/google";
import { tokens } from "@medibun/design-tokens";
import { cookies } from "next/headers";
import { Sidebar } from "./components/sidebar";
import { COLLAPSE_COOKIE } from "./lib/prefs";
import { getSessionStaff } from "./lib/session";
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
  // Session state drives the sidebar footer (identity vs sign-in CTA); reading it here
  // makes every page per-request — correct for an authenticated app shell. The collapse
  // preference is a cookie so the FIRST paint is already collapsed/expanded — no
  // post-hydration flash or layout shift (same pattern as the portal shell).
  const [staff, cookieStore] = await Promise.all([getSessionStaff(), cookies()]);
  const collapsed = cookieStore.get(COLLAPSE_COOKIE)?.value === "1";
  // `data-brand` is the runtime-theming seam: the settings GUI / per-tenant resolution
  // sets it server-side, and the [data-brand] CSS-variable scope swaps the brand with no rebuild.
  return (
    <html lang="en" data-brand="aureva" className={instrumentSans.variable}>
      <body className="antialiased">
        {/* Mobile-first: the shell stacks (top bar over content) below md and becomes
            rail + content beside each other from md up. */}
        {/* h-dvh (not h-screen/min-h): the schedule fills the viewport and scrolls
            INTERNALLY, so `main` must be a bounded, min-h-0 flex child — and dvh tracks
            mobile browser chrome, where 100vh clips the bottom of the sheet. */}
        <div className="flex h-dvh flex-col overflow-hidden md:flex-row">
          <Sidebar staffName={staff?.name} initialCollapsed={collapsed} />
          <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
        </div>
      </body>
    </html>
  );
}
