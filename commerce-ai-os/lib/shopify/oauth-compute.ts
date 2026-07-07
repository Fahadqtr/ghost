// Shopify OAuth helpers — pure, DB-free (unit-tested).
//
// The new Dev Dashboard apps don't hand out admin tokens directly; the store
// grants one through the standard authorization-code flow. /api/shopify/install
// starts it, /api/shopify/callback verifies Shopify's HMAC + our state cookie,
// exchanges the code and stores the permanent offline token.

import crypto from "crypto";

/** Scopes the ghost integration needs (catalog, inventory, orders). */
export const SHOPIFY_SCOPES = [
  "read_products", "write_products",
  "read_inventory", "write_inventory",
  "read_orders", "read_locations",
].join(",");

/** The store-approval URL the owner is redirected to. */
export function buildAuthorizeUrl(opts: { shop: string; clientId: string; redirectUri: string; state: string; scopes?: string }): string {
  const q = new URLSearchParams({
    client_id: opts.clientId,
    scope: opts.scopes ?? SHOPIFY_SCOPES,
    redirect_uri: opts.redirectUri,
    state: opts.state,
  });
  return `https://${opts.shop}/admin/oauth/authorize?${q.toString()}`;
}

/**
 * Shopify signs every callback: hmac = HMAC-SHA256(secret, sorted query string
 * WITHOUT the hmac param). Reject anything that doesn't verify.
 */
export function verifyShopifyHmac(params: Record<string, string>, secret: string): boolean {
  const given = String(params.hmac ?? "");
  if (!given || !secret) return false;
  const message = Object.keys(params)
    .filter((k) => k !== "hmac" && k !== "signature")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(given, "hex"));
  } catch { return false; }
}

/** Only ever talk to the ONE configured store (blocks shop-swap phishing). */
export function isExpectedShop(shopParam: string, configuredDomain: string): boolean {
  const shop = String(shopParam ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) && shop === configuredDomain.trim().toLowerCase();
}
