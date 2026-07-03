// Sales & best-sellers summary (server-only, read-only). Uses the cumulative
// inventory.sold_quantity (incremented on every "sale" OUT movement) × the
// product's effective price. Revenue only — no cost/margin. The aggregation is
// pure and unit-tested in sales-compute.ts; this file only does the I/O.
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/supabase/paginate";
import { computeSalesSummary, type SalesRow } from "./sales-compute";

export type { SoldProduct } from "./sales-compute";

export interface SalesSummary {
  configured: boolean;
  totalUnits: number;
  totalRevenue: number;
  distinctProducts: number;
  topByUnits: import("./sales-compute").SoldProduct[];
  topByRevenue: import("./sales-compute").SoldProduct[];
}

export async function getSalesSummary(topN = 10): Promise<SalesSummary> {
  const empty: SalesSummary = { configured: false, totalUnits: 0, totalRevenue: 0, distinctProducts: 0, topByUnits: [], topByRevenue: [] };
  if (!isSupabaseConfigured()) return empty;

  const sb = createClient();
  let rows: SalesRow[] = [];
  try {
    rows = await fetchAll(
      sb,
      "inventory",
      "product_id, sold_quantity, products(name_en, name_ar, sku, image_url, price, discount_price)"
    ) as SalesRow[];
  } catch {
    return { ...empty, configured: true };
  }

  return { configured: true, ...computeSalesSummary(rows, topN) };
}
