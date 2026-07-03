// Low-stock flagging — pure, DB-free core.
//
// Given inventory rows (each joined to its product), flag the ones at or below
// their restock threshold, split out-of-stock from merely-low, and order them
// out-first then lowest-stock. Kept free of Supabase so it is unit-testable; the
// fetch + the "configured" gate live in lowStock.ts.

// Default "low" line when a row has no explicit threshold set.
export const DEFAULT_LOW_THRESHOLD = 10;

export interface LowStockItem {
  productId: string | null;
  sku: string | null;
  name: string | null;
  nameAr: string | null;
  image: string | null;
  stock: number;
  threshold: number;
  out: boolean; // stock <= 0
}

export interface LowStockSummary {
  outCount: number;
  lowCount: number;
  items: LowStockItem[]; // out-of-stock first, then lowest stock; capped for display
}

/** One inventory row joined to its product (subset we read). */
export interface LowStockRow {
  product_id?: string | null;
  stock_quantity?: number | string | null;
  low_stock_threshold?: number | string | null;
  products?: {
    name_en?: string | null;
    name_ar?: string | null;
    sku?: string | null;
    image_url?: string | null;
  } | null;
}

const EMPTY: LowStockSummary = { outCount: 0, lowCount: 0, items: [] };

/**
 * Flag low/out-of-stock rows.
 *
 * A fresh store ships every row at the untouched 50-unit seed; until at least
 * one row moves off 50 we treat stock as untracked and surface nothing, so the
 * owner isn't drowned in false alerts on day one.
 */
export function computeLowStock(rows: LowStockRow[], limit: number): LowStockSummary {
  const tracked = rows.some((r) => Number(r.stock_quantity) !== 50);
  if (!tracked) return { ...EMPTY };

  const flagged: LowStockItem[] = [];
  for (const r of rows) {
    const stock = Number(r.stock_quantity) || 0;
    const threshold = r.low_stock_threshold != null ? Number(r.low_stock_threshold) : DEFAULT_LOW_THRESHOLD;
    if (stock > threshold) continue;
    flagged.push({
      productId: r.product_id ?? null,
      sku: r.products?.sku ?? null,
      name: r.products?.name_en ?? r.products?.name_ar ?? null,
      nameAr: r.products?.name_ar ?? null,
      image: r.products?.image_url ?? null,
      stock,
      threshold,
      out: stock <= 0,
    });
  }

  const outCount = flagged.filter((f) => f.out).length;
  const lowCount = flagged.length - outCount;
  // Out-of-stock first, then by lowest stock.
  flagged.sort((a, b) => Number(b.out) - Number(a.out) || a.stock - b.stock);

  return { outCount, lowCount, items: flagged.slice(0, limit) };
}
