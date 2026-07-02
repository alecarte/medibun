import type { Metadata } from "next";
import { Fraunces, Instrument_Sans } from "next/font/google";
import { tokens } from "@medibun/design-tokens";
import "./globals.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  axes: ["SOFT", "WONK", "opsz"],
});

const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument-sans",
});

export const metadata: Metadata = {
  title: `${tokens["brand-name"]} Staff`,
  description: "Practitioner and front-desk app for the Aureva / Handal platform.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // `data-brand` is the runtime-theming seam: the settings GUI / per-tenant resolution
  // sets it server-side, and the [data-brand] CSS-variable scope swaps the brand with no rebuild.
  return (
    <html
      lang="en"
      data-brand="aureva"
      className={`${fraunces.variable} ${instrumentSans.variable}`}
    >
      <body className="antialiased">{children}</body>
    </html>
  );
}
