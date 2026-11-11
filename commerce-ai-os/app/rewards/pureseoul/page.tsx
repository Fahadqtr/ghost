import type { Metadata, Viewport } from "next";
import RewardsClient from "../RewardsClient";

// Public, no-auth Beauty Rewards card for PURE SEOUL customers, reached from the
// Pure Seoul QR. Same system as /rewards, but its own customers, prizes and
// voucher codes (brand = "pureseoul"). Covered by the "/rewards" entry in
// middleware PUBLIC_PATHS (prefix match), so it is never redirected to /login.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "بطاقة مكافآت الجمال · Pure Seoul",
  description: "اجمعي ست ختمات عبر تقييماتك لمتجر Pure Seoul في سنونو واحصلي على منتج مجاناً.",
};

export const viewport: Viewport = { themeColor: "#f7ead9" };

export default function PureSeoulRewardsPage() {
  return <RewardsClient brand="pureseoul" />;
}
