import type { Metadata, Viewport } from "next";
import "./globals.css";
import { APP_NAME, APP_OWNER } from "@/lib/constants";
import { getLocale } from "@/lib/i18n-server";
import { dirOf } from "@/lib/i18n";

export const metadata: Metadata = {
  title: `${APP_NAME} — ${APP_OWNER}`,
  description: "Local-first MVP dashboard to manage multiple brands and channels.",
  manifest: "/manifest.webmanifest",
  applicationName: "Malak",
  appleWebApp: { capable: true, title: "Malak", statusBarStyle: "default" },
};

// Without this, mobile browsers assume a ~980px desktop viewport and render the
// whole app zoomed out ("PC size" on the phone). device-width makes the
// responsive breakpoints (sidebar→drawer, stacked cards) actually kick in.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Lock the zoom so the app stays at true device size. Without this, an
  // accidental pinch leaves the page zoomed/panned — content gets cut off at the
  // edges and the screen "widens" on every visit. Locking to scale 1 keeps it
  // fixed at app size like a native app.
  maximumScale: 1,
  userScalable: false,
  themeColor: "#ffffff",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();
  return (
    <html lang={locale} dir={dirOf(locale)}>
      <body>{children}</body>
    </html>
  );
}
