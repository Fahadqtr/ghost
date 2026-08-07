import "server-only";
// Malikas V2 Operations — Shopify presence adapter (Phase UI.7.2).
//
// Bridges the EXISTING UI.3 Shopify read model into a per-product
// PlatformPresence map for the operations engines. It reads nothing new: it
// reuses loadShopifyCatalog, which already matches Malikas rows to Shopify by
// identity and never exposes stock/orders/PII. If Shopify is unavailable the
// result is available:false with an empty map → the engine reports "unknown"
// (غير مربوط), never "missing".

import type { PlatformPresence } from "./shared/models";
import type { OperationsReadClient } from "./read-model";

export async function loadShopifyPresence(
  client: OperationsReadClient,
): Promise<{ available: boolean; byProductId: Map<string, PlatformPresence> }> {
  const byProductId = new Map<string, PlatformPresence>();
  try {
    const m = await import("@/lib/catalog-v2/shopify-catalog-read");
    // loadShopifyCatalog takes the same session client shape used elsewhere.
    const result = await m.loadShopifyCatalog(client as never);
    if (result.status !== "ok" || !result.shopifyAvailable) {
      return { available: false, byProductId };
    }
    for (const row of result.rows) {
      const id = row.masterProductId;
      if (typeof id !== "string" || id === "") continue;
      const linked = row.matchStatus === "matched_sku" || row.matchStatus === "matched_barcode";
      const ambiguous = row.matchStatus === "ambiguous";
      const live = linked && row.shopifyStatus === "active";
      // Roll up to the product: once any sellable entity is linked/live, the
      // product counts as linked/live. Ambiguity anywhere → review required.
      const prev = byProductId.get(id);
      byProductId.set(id, {
        linked: (prev?.linked ?? false) || linked,
        live: (prev?.live ?? false) || live,
        drift: prev?.drift ?? false, // UI.3 read model does not expose field-level drift yet
        reviewRequired: (prev?.reviewRequired ?? false) || ambiguous,
      });
    }
    return { available: true, byProductId };
  } catch {
    return { available: false, byProductId };
  }
}
