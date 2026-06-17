import type { Metadata, Viewport } from "next";
import "./globals.css";
import { APP_NAME, APP_OWNER } from "@/lib/constants";

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
  themeColor: "#ffffff",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
