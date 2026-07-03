// Sales & best-sellers aggregation — pure, DB-free core.
//
// From inventory rows carrying the cumulative sold_quantity (incremented on
// every "sale" OUT) and the joined product price, compute total units/revenue,
// the count of products that actually sold, and the top-N by units and by
// revenue. Revenue only — no cost/margin. Kept free of Supabase so it is
// unit-testable; the fetch + the "configured" gate live in sales.ts.

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

export interface SalesTotals {
  totalUnits: number;
  totalRevenue: number;
  distinctProducts: number; // products with at least one sale
  topByUnits: SoldProduct[];
  topByRevenue: SoldProduct[];
}

/** One inventory row joined to its product (subset we read). */
export interface SalesRow {
  product_id?: string | null;
  sold_quantity?: number | string | null;
  products?: {
    name_en?: string | null;
    name_ar?: string | null;
    sku?: string | null;
    image_url?: string | null;
    price?: number | string | null;
    discount_price?: number | string | null;
  } | null;
}

/** Aggregate sales from inventory rows. `topN` caps each best-seller list. */
export function computeSalesSummary(rows: SalesRow[], topN: number): SalesTotals {
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
    totalUnits,
    totalRevenue,
    distinctProducts: sold.length,
    topByUnits,
    topByRevenue,
  };
}
