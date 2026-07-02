import type { Metadata } from "next";
import { Instrument_Sans } from "next/font/google";
import { tokens } from "@medibun/design-tokens";
import { Sidebar } from "./components/sidebar";
import { getSessionProfile } from "./lib/session";
import "./globals.css";

const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument-sans",
});

export const metadata: Metadata = {
  title: `${tokens["brand-name"]} Portal`,
  description: "Patient portal for the Aureva / Handal platform.",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Session state drives the sidebar (signed in vs sign-in CTA); reading it here makes
  // every page per-request — correct for an authenticated app shell.
  const profile = await getSessionProfile();
  // `data-brand` is the runtime-theming seam: the settings GUI / per-tenant resolution
  // sets it server-side, and the [data-brand] CSS-variable scope swaps the brand with no rebuild.
  return (
    <html lang="en" data-brand="aureva" className={instrumentSans.variable}>
      <body className="antialiased">
        <div className="flex min-h-screen">
          <Sidebar profileName={profile?.name} />
          <main className="flex-1">{children}</main>
        </div>
      </body>
    </html>
  );
}
