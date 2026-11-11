// Absolute URL of a store's public Beauty Rewards page (what its QR encodes).
// SERVER ONLY (reads request headers). Built from the request host so it works
// on whatever domain the app is deployed to; NEXT_PUBLIC_SITE_URL overrides it
// when the public link should differ from the admin host.
import { headers } from "next/headers";
import { BRAND_INFO, type LoyaltyBrand } from "@/lib/loyalty/brand";

export async function publicRewardsUrl(brand: LoyaltyBrand): Promise<string> {
  const publicPath = BRAND_INFO[brand].publicPath;
  const env = process.env.NEXT_PUBLIC_SITE_URL;
  if (env) return `${env.replace(/\/$/, "")}${publicPath}`;
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  return `${proto}://${host}${publicPath}`;
}
