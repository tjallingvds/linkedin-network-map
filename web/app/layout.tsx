import type { Metadata } from "next";
import { Hedvig_Letters_Serif, Instrument_Sans } from "next/font/google";
import AppShell from "./components/AppShell";
import { cn } from "./lib/cn";
import "./globals.css";

/* Same pairing flowviz settled on: midday's Hedvig serif for display, with
 * Instrument Sans carrying 400-700 for the UI (Hedvig Sans is a single 400
 * weight, which flattens the hierarchy). */
const sans = Instrument_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const serif = Hedvig_Letters_Serif({
  weight: "400",
  subsets: ["latin"],
  display: "swap",
  variable: "--font-serif",
});

export const metadata: Metadata = {
  title: "Observable Intuition — CRM",
  description: "Prospecting CRM",
};

export const viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={cn(
          `${sans.variable} ${serif.variable} font-sans`,
          "overscroll-none antialiased",
        )}
      >
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
