// Scheduled availability sync — pure, DB-free core.
//
// The manual reconcile (lib/availability-reconcile.ts) needs uploaded platform
// sheets, so it can only run when a human exports each dashboard. This module is
// the automatable half: it propagates the ONE signal we always hold in our own
// DB — the master inventory — to every overlay platform's availability, so the
// whole system reflects real stock without a manual "apply" each time.
//
// Truth model: ONE company, ONE inventory. The master inventory is the source of
// truth; the scheduled sync makes every overlay platform match it. Effective
// stock per product = max(inventory total, summed variant stock) — identical to
// the out-of-stock page, so the cron and that screen never disagree. A product
// is OutOfStock when effective stock is 0, InStock otherwise.
//
// (Upload-driven, platform-specific signals — a platform selling out while the
// master still shows stock — remain the job of the manual reconcile, which
// surfaces them as conflicts. The scheduled sync assumes master stock is truth.)
//
// No next/headers and no Supabase here, so it is unit-testable directly.

export type Availability = "InStock" | "OutOfStock";

/** One row of the master `inventory` table (subset). */
export interface InventoryRow {
  product_id: string | null;
  stock_quantity: number | null;
}

/** One row of `product_variants` (subset) — options roll up to their parent. */
export interface VariantRow {
  parent_product_id: string | null;
  stock_quantity: number | null;
}

/** Desired availability for a single product, derived from master stock. */
export interface ProductStatus {
  product_id: string;
  availability: Availability;
}

/** An upsert destined for `platform_status` (product × platform overlay). */
export interface StatusUpsert {
  product_id: string;
  platform: string;
  availability: Availability;
  updated_at: string;
}

export interface SyncCounts {
  products: number;   // distinct products with an inventory signal
  out: number;        // reconciled OutOfStock
  inStock: number;    // reconciled InStock
}

/**
 * Derive each product's availability from master stock.
 *
 * Effective stock = max(inventory total, summed variant stock): a product with
 * options is out only when BOTH its own inventory total AND every option are 0,
 * so a product that still has stock on either side is never marked out.
 * Multiple inventory rows for one product roll up by max (stock anywhere counts).
 */
export function computeStockStatus(
  inventory: InventoryRow[],
  variants: VariantRow[],
): ProductStatus[] {
  const variantSum = new Map<string, number>();
  for (const v of variants) {
    if (!v.parent_product_id) continue;
    variantSum.set(v.parent_product_id, (variantSum.get(v.parent_product_id) ?? 0) + (v.stock_quantity ?? 0));
  }

  const invMax = new Map<string, number>();
  for (const r of inventory) {
    if (!r.product_id) continue;
    const q = r.stock_quantity ?? 0;
    invMax.set(r.product_id, Math.max(invMax.get(r.product_id) ?? 0, q));
  }

  const out: ProductStatus[] = [];
  for (const [product_id, inv] of invMax) {
    const effective = Math.max(inv, variantSum.get(product_id) ?? 0);
    out.push({ product_id, availability: effective > 0 ? "InStock" : "OutOfStock" });
  }
  return out;
}

/** Key for the current-state lookup: one availability per (product, platform). */
export function statusKey(productId: string, platform: string): string {
  return `${productId}|${platform}`;
}

/**
 * Plan the minimal set of `platform_status` upserts to bring every overlay
 * platform in line with the master-derived status. Only rows whose current
 * availability differs from the desired one are emitted, so a run that changes
 * nothing writes nothing.
 *
 * @param current Map of statusKey(product, platform) → current availability
 *                ("InStock" | "OutOfStock"); a missing entry counts as unset and
 *                always produces an upsert.
 */
export function planStatusUpserts(
  statuses: ProductStatus[],
  overlayPlatforms: readonly string[],
  current: Map<string, string>,
  nowIso: string,
): { upserts: StatusUpsert[]; counts: SyncCounts } {
  const upserts: StatusUpsert[] = [];
  let out = 0;
  let inStock = 0;
  for (const s of statuses) {
    if (s.availability === "OutOfStock") out++;
    else inStock++;
    for (const platform of overlayPlatforms) {
      if (current.get(statusKey(s.product_id, platform)) === s.availability) continue;
      upserts.push({ product_id: s.product_id, platform, availability: s.availability, updated_at: nowIso });
    }
  }
  return { upserts, counts: { products: statuses.length, out, inStock } };
}
