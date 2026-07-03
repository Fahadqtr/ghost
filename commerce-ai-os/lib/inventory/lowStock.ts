// Low-stock alert data (server-only, read-only). Surfaces the products that
// need restocking so the owner sees them at a glance on the dashboard. Uses the
// inventory row's own quantity + threshold; the inventory page stays the full
// source of truth (variants, shelves, etc.). The flagging/sort logic is pure and
// unit-tested in lowStock-compute.ts; this file only does the I/O.
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/supabase/paginate";
import { computeLowStock, type LowStockRow } from "./lowStock-compute";

export { DEFAULT_LOW_THRESHOLD } from "./lowStock-compute";
export type { LowStockItem } from "./lowStock-compute";

export interface LowStockAlerts {
  configured: boolean;
  outCount: number;
  lowCount: number;
  items: import("./lowStock-compute").LowStockItem[];
}

export async function getLowStockAlerts(limit = 12): Promise<LowStockAlerts> {
  if (!isSupabaseConfigured()) return { configured: false, outCount: 0, lowCount: 0, items: [] };

  const sb = createClient();
  let rows: LowStockRow[] = [];
  try {
    rows = await fetchAll(
      sb,
      "inventory",
      "product_id, stock_quantity, low_stock_threshold, products(name_en, name_ar, sku, image_url)"
    ) as LowStockRow[];
  } catch {
    return { configured: true, outCount: 0, lowCount: 0, items: [] };
  }

  return { configured: true, ...computeLowStock(rows, limit) };
}
