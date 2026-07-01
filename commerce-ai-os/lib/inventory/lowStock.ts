// Low-stock alert data (server-only, read-only). Surfaces the products that
// need restocking so the owner sees them at a glance on the dashboard. Uses the
// inventory row's own quantity + threshold; the inventory page stays the full
// source of truth (variants, shelves, etc.).
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/supabase/paginate";

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

export interface LowStockAlerts {
  configured: boolean;
  outCount: number;
  lowCount: number;
  items: LowStockItem[]; // out-of-stock first, then lowest stock; capped for display
}

export async function getLowStockAlerts(limit = 12): Promise<LowStockAlerts> {
  if (!isSupabaseConfigured()) return { configured: false, outCount: 0, lowCount: 0, items: [] };

  const sb = createClient();
  let rows: any[] = [];
  try {
    rows = await fetchAll(
      sb,
      "inventory",
      "product_id, stock_quantity, low_stock_threshold, products(name_en, name_ar, sku, image_url)"
    );
  } catch {
    return { configured: true, outCount: 0, lowCount: 0, items: [] };
  }

  // Ignore the untouched 50-unit seed so a fresh store isn't drowned in alerts.
  const tracked = rows.some((r) => Number(r.stock_quantity) !== 50);
  if (!tracked) return { configured: true, outCount: 0, lowCount: 0, items: [] };

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

  return { configured: true, outCount, lowCount, items: flagged.slice(0, limit) };
}
