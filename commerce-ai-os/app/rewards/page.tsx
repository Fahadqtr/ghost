import type { Metadata, Viewport } from "next";
import RewardsClient from "./RewardsClient";

// Public, no-auth customer page reached from the printed QR. Lives OUTSIDE the
// (app) route group so it never renders the admin shell, and is whitelisted in
// middleware (PUBLIC_PATHS) so it isn't redirected to /login.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "بطاقة مكافآت الجمال · Malika's Universe",
  description: "اجمعي خمس ختمات عبر تقييماتك في سنونو واحصلي على منتج مجاناً.",
};

// Let customers zoom the card if they want (the admin app locks zoom; here we
// don't need to).
export const viewport: Viewport = { themeColor: "#f7ead9" };

export default function RewardsPage() {
  return <RewardsClient />;
}
