// Central, dependency-injected core for pushing our stock quantities to
// Shopify. It performs NO I/O itself — it receives the canonical Shopify
// capabilities (config check, location resolution, inventory-item resolution,
// quantity set) as `deps` and orchestrates them. The real deps are wired to the
// single central client in `lib/shopify/admin.ts` by
// `pushInventoryStockToShopify()`; tests inject mocks.
//
// Why a pure core: `admin.ts` imports `server-only` + the service-role Supabase
// client, so it can't be imported by node:test. Keeping the decision logic here
// (no `server-only`, no `@/` imports) makes every branch — not_configured,
// missing_location, missing_inventory_item, shopify_error, synced — unit
// testable with mocks, and guarantees there is no "silent success" path (a
// `synced:true` is only ever returned after a real setQuantity call succeeds).

/** Why a single SKU did (or did not) sync. Fixed enum — never carries raw data. */
export type ShopifyStockSyncReason =
  | "not_configured"          // Shopify isn't connected — no request was attempted
  | "missing_location"        // no active inventory location could be resolved
  | "missing_inventory_item"  // the SKU has no matching Shopify inventory item
  | "archived_only"           // the ONLY product with this SKU is archived (retired) — never written to
  | "ambiguous_sku"           // 2+ eligible products/items share this SKU — fail closed, nothing written
  | "shopify_error";          // Shopify returned an error for the set

/** Result of syncing ONE SKU's quantity to Shopify. */
export type ShopifyStockSyncResult =
  | { synced: true }
  | { synced: false; reason: ShopifyStockSyncReason };

/** Aggregate outcome of a batch push. */
export interface ShopifyStockPushSummary {
  configured: boolean;   // false ⇒ not_configured; NO external call was made
  attempted: number;     // SKUs we actually tried to push (0 on a batch-level stop)
  pushed: number;        // SKUs whose quantity was set on Shopify
  failed: number;        // SKUs that resolved but whose set failed (shopify_error)
  missing: number;       // SKUs with no matching Shopify inventory item
  // Batch-level early stop, if any. Per-SKU reasons live in `perItem`.
  reason?: "not_configured" | "missing_location";
  perItem: { sku: string; result: ShopifyStockSyncResult }[];
}

/**
 * The canonical Shopify capabilities this core needs, injected so the core
 * stays pure. Each maps to a function on the central client:
 *   configured            → shopifyConfigured()
 *   resolveLocationId     → fetchPrimaryLocationId()
 *   resolveInventoryItemId→ resolveInventoryItemIdBySku()
 *   setQuantity           → setInventoryQuantities() (single-item)
 * None of these expose tokens/headers/URLs to this module.
 */
export interface ShopifyStockPushDeps {
  configured: () => boolean;
  resolveLocationId: () => Promise<{ locationId?: string; error?: string }>;
  /**
   * MUST return an inventory item belonging to a NON-ARCHIVED product, and MUST
   * fail closed (empty id + a `reason`) when the SKU is ambiguous — the real
   * implementation is `resolveInventoryItemIdBySku()`, which enforces both.
   */
  resolveInventoryItemId: (
    sku: string,
  ) => Promise<{ inventoryItemId?: string; error?: string; reason?: "none" | "archived_only" | "ambiguous" }>;
  setQuantity: (locationId: string, inventoryItemId: string, quantity: number) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Push each {sku, quantity} to Shopify through the central client.
 *
 * Guarantees:
 *  - If Shopify isn't configured, returns not_configured WITHOUT any external
 *    call (never a silent success).
 *  - If no location resolves, returns missing_location before touching items.
 *  - A SKU with no inventory item → missing_inventory_item (not counted pushed).
 *  - A failed set → shopify_error (not counted pushed).
 *  - synced:true for a SKU is returned ONLY after setQuantity actually succeeds.
 */
export async function syncStockBySku(
  items: { sku: string; quantity: number }[],
  deps: ShopifyStockPushDeps,
): Promise<ShopifyStockPushSummary> {
  if (!deps.configured()) {
    return { configured: false, attempted: 0, pushed: 0, failed: 0, missing: 0, reason: "not_configured", perItem: [] };
  }

  const loc = await deps.resolveLocationId();
  if (loc.error || !loc.locationId) {
    return { configured: true, attempted: 0, pushed: 0, failed: 0, missing: 0, reason: "missing_location", perItem: [] };
  }
  const locationId = loc.locationId;

  let pushed = 0, failed = 0, missing = 0;
  const perItem: { sku: string; result: ShopifyStockSyncResult }[] = [];

  for (const it of items) {
    const resolved = await deps.resolveInventoryItemId(it.sku);
    if (resolved.error) {
      failed++;
      perItem.push({ sku: it.sku, result: { synced: false, reason: "shopify_error" } });
      continue;
    }
    if (!resolved.inventoryItemId) {
      // No operational target. `archived_only` / `ambiguous_sku` are surfaced
      // distinctly so a duplicate-SKU collision is visible instead of looking
      // like an ordinary "not on Shopify yet" miss. All three count as missing:
      // nothing was written, which is the whole point.
      missing++;
      const reason: ShopifyStockSyncReason =
        resolved.reason === "archived_only" ? "archived_only"
        : resolved.reason === "ambiguous" ? "ambiguous_sku"
        : "missing_inventory_item";
      perItem.push({ sku: it.sku, result: { synced: false, reason } });
      continue;
    }
    const set = await deps.setQuantity(locationId, resolved.inventoryItemId, it.quantity);
    if (!set.ok) {
      failed++;
      perItem.push({ sku: it.sku, result: { synced: false, reason: "shopify_error" } });
      continue;
    }
    pushed++;
    perItem.push({ sku: it.sku, result: { synced: true } });
  }

  return { configured: true, attempted: items.length, pushed, failed, missing, perItem };
}

/** Compact, UI-safe status derived from a summary — no SKUs, no raw errors. */
export interface ShopifyStockSyncStatus {
  configured: boolean;
  synced: boolean;   // true only when connected, something was attempted, and nothing failed
  pushed: number;
  failed: number;
  missing: number;
  reason?: "not_configured" | "missing_location";
}

/** Reduce a batch summary to the safe status the UI shows the user. */
export function summarizeStockSync(summary: ShopifyStockPushSummary): ShopifyStockSyncStatus {
  const synced =
    summary.configured &&
    !summary.reason &&
    summary.attempted > 0 &&
    summary.failed === 0 &&
    summary.missing === 0;
  return {
    configured: summary.configured,
    synced,
    pushed: summary.pushed,
    failed: summary.failed,
    missing: summary.missing,
    ...(summary.reason ? { reason: summary.reason } : {}),
  };
}
