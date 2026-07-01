// Sales & best-sellers summary (server-only, read-only). Uses the cumulative
// inventory.sold_quantity (incremented on every "sale" OUT movement) × the
// product's effective price. Revenue only — no cost/margin.
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/supabase/paginate";

export interface SoldProduct {
  productId: string | null;
  sku: string | null;
  name: string | null;
  nameAr: string | null;
  image: string | null;
  units: number;
  price: number;    // effective unit price used for revenue
  revenue: number;  // units × price
}

export interface SalesSummary {
  configured: boolean;
  totalUnits: number;
  totalRevenue: number;
  distinctProducts: number; // products with at least one sale
  topByUnits: SoldProduct[];
  topByRevenue: SoldProduct[];
}

export async function getSalesSummary(topN = 10): Promise<SalesSummary> {
  if (!isSupabaseConfigured()) {
    return { configured: false, totalUnits: 0, totalRevenue: 0, distinctProducts: 0, topByUnits: [], topByRevenue: [] };
  }
  const sb = createClient();
  let rows: any[] = [];
  try {
    rows = await fetchAll(
      sb,
      "inventory",
      "product_id, sold_quantity, products(name_en, name_ar, sku, image_url, price, discount_price)"
    );
  } catch {
    return { configured: true, totalUnits: 0, totalRevenue: 0, distinctProducts: 0, topByUnits: [], topByRevenue: [] };
  }

  const sold: SoldProduct[] = [];
  let totalUnits = 0, totalRevenue = 0;
  for (const r of rows) {
    const units = Number(r.sold_quantity) || 0;
    if (units <= 0) continue;
    const p = r.products || {};
    // Effective price: prefer an active discount price, else list price.
    const price = Number(p.discount_price ?? p.price) || 0;
    const revenue = units * price;
    totalUnits += units;
    totalRevenue += revenue;
    sold.push({
      productId: r.product_id ?? null,
      sku: p.sku ?? null,
      name: p.name_en ?? p.name_ar ?? null,
      nameAr: p.name_ar ?? null,
      image: p.image_url ?? null,
      units,
      price,
      revenue,
    });
  }

  const topByUnits = [...sold].sort((a, b) => b.units - a.units).slice(0, topN);
  const topByRevenue = [...sold].sort((a, b) => b.revenue - a.revenue).slice(0, topN);

  return {
    configured: true,
    totalUnits,
    totalRevenue,
    distinctProducts: sold.length,
    topByUnits,
    topByRevenue,
  };
}
