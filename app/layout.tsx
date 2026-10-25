import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Instrument Serif (OFL), self-hosted: a narrow, film-title serif for every line of UI, set like old subtitles
const serif = localFont({
  src: [
    { path: "./fonts/InstrumentSerif-Regular.woff2", style: "normal", weight: "400" },
    { path: "./fonts/InstrumentSerif-Italic.woff2", style: "italic", weight: "400" },
  ],
  variable: "--font-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: "blue hour",
  description: "pov: it's blue hour in eastern europe",
};

export const viewport: Viewport = {
  themeColor: "#0b1530",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={serif.variable}>
      <body>{children}</body>
    </html>
  );
}
