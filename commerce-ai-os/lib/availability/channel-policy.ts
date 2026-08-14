// Channel availability propagation policy (INV.2D) — pure, declarative.
//
// One place that records HOW each sales channel receives availability.
// Availability is the explicit products.stock_status (projected to
// platform_status.availability); this map documents the OUTBOUND mode per channel
// so no path silently invents a new external write.
//
// Modes:
//  - "push_zero_on_oos": Shopify — the only channel with a live outbound write.
//    Out of Stock ⇒ push external quantity 0; In Stock ⇒ leave the store quantity
//    untouched this phase (local counts are not yet trusted). Never writes a local
//    quantity to represent availability.
//  - "export_flag": Talabat — availability rides the CSV export snapshot flag
//    (InStock / OutOfStock). No live API.
//  - "none": Snoonu / Pure Seoul / Rafeeq — NO outbound availability today. They
//    receive the internal platform_status projection only; no external write.
//
// PURE: no DB, no React, no next/*, no server-only (imports only the pure
// availability read-model).

import { isAvailable } from "./read.ts";

export type ChannelAvailabilityMode = "push_zero_on_oos" | "export_flag" | "none";

export const CHANNEL_AVAILABILITY_MODE: Record<string, ChannelAvailabilityMode> = {
  shopify: "push_zero_on_oos",
  talabat: "export_flag",
  snoonu: "none",
  pure_seoul: "none",
  rafeeq: "none",
};

export function channelAvailabilityMode(platform: string): ChannelAvailabilityMode {
  return CHANNEL_AVAILABILITY_MODE[platform] ?? "none";
}

/**
 * Explicit no-op outbound adapter for channels with no availability API today
 * (Snoonu / Pure Seoul / Rafeeq). Documents intent and guards against a future
 * accidental external write — it performs NO network/DB side effect.
 */
export function noopChannelAvailabilityPush(platform: string): { platform: string; pushed: false; reason: string } {
  return { platform, pushed: false, reason: "no outbound availability API for this channel (internal projection only)" };
}

/** Product subset needed to decide the Shopify availability push. */
export interface ProductAvailabilityLite {
  id: string;
  sku: string | null;
  name_en: string | null;
  stock_status: string | null;
}

/**
 * INV.2D Shopify push list (mode "push_zero_on_oos"): ONLY Out-of-Stock products,
 * each targeted to external quantity 0. In-Stock products are OMITTED so their
 * Shopify quantity is never overwritten with an untrusted local count this phase.
 * Derived purely from explicit availability — no local quantity is read or written.
 */
export function shopifyOosZeroPushList(
  products: ProductAvailabilityLite[],
): { id: string; sku: string | null; name_en: string | null; stock: number }[] {
  return products
    .filter((p) => !isAvailable(p.stock_status))
    .map((p) => ({ id: p.id, sku: p.sku, name_en: p.name_en, stock: 0 }));
}
