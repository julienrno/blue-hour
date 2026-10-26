import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Analytics } from "@vercel/analytics/next";
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

// The live address on Vercel (it follows the project's production domain, so switching to a custom domain later
// needs no change here); localhost when running locally
const SITE = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : "http://localhost:3000";
const TITLE = "blue hour";
const DESCRIPTION =
  "pov: it’s blue hour in eastern europe. wander a snowed-in town of panel blocks at dusk: climb the roofs and the radio mast, throw snowballs, find the 24h shop.";

// The share image and the icons are files next to this one (opengraph-image, twitter-image, icon, apple-icon)
export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: TITLE,
  openGraph: { title: TITLE, description: DESCRIPTION, siteName: TITLE, type: "website", url: "/" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

export const viewport: Viewport = {
  themeColor: "#0b1530",
  // Fill the whole screen on notched phones; the controls keep clear of the notch and home bar themselves
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={serif.variable}>
      <body>
        {children}
        {/* Page views on Vercel (no cookies); does nothing when running locally */}
        <Analytics />
      </body>
    </html>
  );
}
