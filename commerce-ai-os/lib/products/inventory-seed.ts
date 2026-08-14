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
