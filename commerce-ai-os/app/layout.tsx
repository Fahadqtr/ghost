import type { Metadata } from "next";
import "./globals.css";
import { APP_NAME, APP_OWNER } from "@/lib/constants";

export const metadata: Metadata = {
  title: `${APP_NAME} — ${APP_OWNER}`,
  description: "Local-first MVP dashboard to manage multiple brands and channels.",
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
