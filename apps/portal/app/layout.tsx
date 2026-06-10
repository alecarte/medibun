import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aureva Portal",
  description: "Patient portal for the Aureva / Handal platform.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // `data-brand` is the runtime-theming seam: the settings GUI / per-tenant resolution
  // sets it server-side, and the [data-brand] CSS-variable scope swaps the brand with no rebuild.
  return (
    <html lang="en" data-brand="default">
      <body>{children}</body>
    </html>
  );
}
