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

type PresenceResult = { available: boolean; byProductId: Map<string, PlatformPresence> };

// The subset of the UI.3 Shopify catalog result this bridge consumes. The real
// loader (loadShopifyCatalog) is bound lazily in production; tests inject a fake
// (the "@/" dynamic import can't resolve under node:test), which also lets the
// cache behavior be verified without any network.
type ShopifyCatalogRow = { masterProductId?: unknown; matchStatus?: unknown; shopifyStatus?: unknown };
type ShopifyCatalogResult = { status: string; shopifyAvailable?: boolean; rows?: readonly ShopifyCatalogRow[] };
export type ShopifyCatalogLoader = (client: OperationsReadClient) => Promise<ShopifyCatalogResult>;

// Short in-process cache for the Shopify presence map. The full read hits the
// Shopify Admin API (fetchAllShopifyProducts paginates up to 50 GraphQL calls),
// so /v2/tasks and /v2/operations — and every per-task preview/sync round-trip —
// were re-fetching the whole catalog each time. Shopify presence is a
// BEST-EFFORT signal (the engine already tolerates it being absent), so serving
// it from a brief cache is safe; only SUCCESSFUL reads are cached, so a transient
// Shopify failure is never pinned and simply retries on the next call. The store
// catalog is global (owner-only surface), so the cache is not keyed per session.
const TTL_MS = 60_000;
let cache: { at: number; data: PresenceResult } | null = null;

/** Test-only: clear the presence cache between cases. */
export function __resetShopifyPresenceCache(): void {
  cache = null;
}

export async function loadShopifyPresence(
  client: OperationsReadClient,
  deps?: { loadCatalog?: ShopifyCatalogLoader; now?: () => number },
): Promise<PresenceResult> {
  const now = (deps?.now ?? Date.now)();
  if (cache && now - cache.at < TTL_MS) return cache.data;
  const byProductId = new Map<string, PlatformPresence>();
  try {
    const loadCatalog: ShopifyCatalogLoader =
      deps?.loadCatalog ??
      (async (c) => {
        // loadShopifyCatalog takes the same session client shape used elsewhere.
        const m = await import("@/lib/catalog-v2/shopify-catalog-read");
        return m.loadShopifyCatalog(c as never) as unknown as ShopifyCatalogResult;
      });
    const result = await loadCatalog(client);
    if (result.status !== "ok" || !result.shopifyAvailable) {
      // Degraded — do NOT cache, so a transient outage retries next call.
      return { available: false, byProductId };
    }
    for (const row of result.rows ?? []) {
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
    const data: PresenceResult = { available: true, byProductId };
    cache = { at: now, data }; // cache only a successful, available read
    return data;
  } catch {
    return { available: false, byProductId };
  }
}
