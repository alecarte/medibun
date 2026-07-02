import type { Metadata } from "next";
import { Instrument_Sans } from "next/font/google";
import { tokens } from "@medibun/design-tokens";
import { Sidebar } from "./components/sidebar";
import "./globals.css";

const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument-sans",
});

export const metadata: Metadata = {
  title: `${tokens["brand-name"]} Portal`,
  description: "Patient portal for the Aureva / Handal platform.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // `data-brand` is the runtime-theming seam: the settings GUI / per-tenant resolution
  // sets it server-side, and the [data-brand] CSS-variable scope swaps the brand with no rebuild.
  return (
    <html lang="en" data-brand="aureva" className={instrumentSans.variable}>
      <body className="antialiased">
        <div className="flex min-h-screen">
          <Sidebar />
          <main className="flex-1">{children}</main>
        </div>
      </body>
    </html>
  );
}
