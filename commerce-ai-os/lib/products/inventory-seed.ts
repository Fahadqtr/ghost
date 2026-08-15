// Catalog create-path convergence (P1) — the ONE shape of an inventory seed row.
//
// Every product-creation path seeds a fresh `inventory` row so the new product is
// stock-trackable immediately. Historically each path spelled that row out inline,
// which let them drift (some omit low_stock_threshold / sold_quantity). This helper
// is the single source of truth for the seed's columns; call sites spread it after
// their own `product_id`, e.g.  { product_id, ...inventorySeed(qty) }.
//
// PURE: deterministic, no DB, no React, no server/browser APIs, no `@/` imports —
// node:test loads it directly. It only shapes an object; it performs no write.

/** The columns of a freshly-seeded inventory row (product_id is added by the caller). */
export interface InventorySeed {
  stock_quantity: number;
  low_stock_threshold: number;
  sold_quantity: number;
}

/**
 * The canonical inventory seed for a newly-created product: the given starting
 * stock, the house low-stock threshold (5), and zero sold. This is exactly the
 * shape createProductCore has always written; extracting it keeps every adopting
 * create path from drifting on the threshold / sold_quantity columns.
 */
export function inventorySeed(quantity: number): InventorySeed {
  return {
    stock_quantity: quantity,
    low_stock_threshold: 5,
    sold_quantity: 0,
  };
}

// INV.6A — create-time authority helpers (pure). A product's starting stock must
// be a well-formed non-negative int4; for a VARIANT product the parent inventory
// seed is Σ variants (top-level stock is NEVER authoritative). 2147483647 = int4 max.

const INT4_MAX = 2147483647;

/** A valid seed is a non-negative integer within int4. Blank/null is NOT allowed
 *  here (the simple-create caller passes an explicit number). */
export function isValidSeedQuantity(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= INT4_MAX;
}

/**
 * Normalize ONE variant's create-time stock to its authoritative value:
 *   blank / null / undefined → 0 (an option with no entered stock starts empty),
 *   a non-negative integer within int4 → itself,
 *   anything else (negative / fractional / NaN / Infinity / overflow / non-numeric)
 *   → null, signalling a validation failure the caller must reject.
 */
export function normalizeVariantStockForSeed(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > INT4_MAX) return null;
  return n;
}

export type VariantParentSeed =
  | { ok: true; seed: number; normalized: number[] }
  | { ok: false; reason: "invalid_variant_stock" };

/**
 * The authoritative parent inventory seed for a VARIANT product = Σ normalized
 * variant stock. Fails closed if ANY variant stock is malformed or the sum
 * overflows int4. `normalized` returns each variant's normalized stock in order
 * so the caller can insert the variant rows with the same authoritative values.
 */
export function computeVariantParentSeed(variantStocks: readonly unknown[]): VariantParentSeed {
  let sum = 0;
  const normalized: number[] = [];
  for (const v of variantStocks) {
    const n = normalizeVariantStockForSeed(v);
    if (n === null) return { ok: false, reason: "invalid_variant_stock" };
    normalized.push(n);
    sum += n;
    if (sum > INT4_MAX) return { ok: false, reason: "invalid_variant_stock" };
  }
  return { ok: true, seed: sum, normalized };
}
