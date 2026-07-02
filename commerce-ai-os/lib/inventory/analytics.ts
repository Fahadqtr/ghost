// Deeper inventory analytics (dead stock · margins · valuation), split into a
// PURE computation over joined inventory+product rows (unit-testable) and a
// thin fetch wrapper that mirrors lib/inventory/sales.ts.
//
// Definitions (kept consistent with the rest of the app):
// - Effective price = discount_price when set, else price (same rule as sales).
// - Dead stock     = in stock but has NEVER sold (cumulative sold_quantity = 0).
//                    Ranked by the money tied up on the shelf.
// - Below cost     = effective price < cost — the Constitution's red line, but
//                    for prices that are ALREADY live (not a proposed change).
// - Valuation      = stock × cost ("at cost") and stock × effective price
//                    ("at price"). Cost coverage tells how trustworthy the
//                    at-cost number is (products missing cost are excluded).

// NOTE: no top-level Supabase imports — they're pulled in lazily inside
// getInventoryAnalytics() so this module stays importable by the plain Node
// test runner (the "@/" alias only exists in Next's bundler). Same pure-module
// pattern as lib/snoonu-diff.ts / lib/briefing.ts.

export interface AnalyticsRow {
  productId: string | null;
  sku: string | null;
  name: string | null;
  nameAr: string | null;
  image: string | null;
  stock: number;
  sold: number;
  price: number | null;
  discountPrice: number | null;
  cost: number | null;
}

export interface DeadStockItem {
  productId: string | null;
  sku: string | null;
  name: string | null;
  nameAr: string | null;
  image: string | null;
  stock: number;
  tiedUp: number;          // stock × (cost, else effective price) — money on the shelf
  basis: "cost" | "price"; // which one tiedUp used
}

export interface MarginItem {
  productId: string | null;
  sku: string | null;
  name: string | null;
  nameAr: string | null;
  image: string | null;
  price: number;      // effective price
  cost: number;
  margin: number;     // price − cost (per unit)
  marginPct: number;  // margin / price × 100 (0 when price is 0)
}

export interface InventoryAnalytics {
  deadStock: { count: number; units: number; tiedUpAtCost: number; tiedUpAtPrice: number; items: DeadStockItem[] };
  margins: {
    withCost: number;          // products that have a usable cost
    costCoveragePct: number;   // share of products with cost (0-100)
    belowCost: MarginItem[];   // live price < cost — needs action
    lowest: MarginItem[];      // thinnest margins first (below-cost included)
    estProfit: number;         // Σ sold × (price − cost) over cost-known rows
    profitMarginPct: number;   // estProfit / revenue-with-cost × 100
  };
  valuation: { skus: number; units: number; atCost: number; atPrice: number };
}

const effectivePrice = (r: AnalyticsRow): number => Number(r.discountPrice ?? r.price) || 0;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeAnalytics(rows: AnalyticsRow[], topN = 12): InventoryAnalytics {
  const dead: DeadStockItem[] = [];
  const withCost: MarginItem[] = [];
  let deadUnits = 0, deadAtCost = 0, deadAtPrice = 0;
  let units = 0, atCost = 0, atPrice = 0, skus = 0;
  let estProfit = 0, revenueWithCost = 0;

  for (const r of rows) {
    const stock = Number(r.stock) || 0;
    const sold = Number(r.sold) || 0;
    const price = effectivePrice(r);
    const cost = r.cost != null && Number(r.cost) > 0 ? Number(r.cost) : null;

    skus++;
    units += stock;
    atPrice += stock * price;
    if (cost != null) atCost += stock * cost;

    if (stock > 0 && sold === 0) {
      const basis: DeadStockItem["basis"] = cost != null ? "cost" : "price";
      const tiedUp = stock * (cost ?? price);
      dead.push({ productId: r.productId, sku: r.sku, name: r.name, nameAr: r.nameAr, image: r.image, stock, tiedUp: round2(tiedUp), basis });
      deadUnits += stock;
      deadAtCost += stock * (cost ?? 0);
      deadAtPrice += stock * price;
    }

    if (cost != null) {
      const margin = price - cost;
      withCost.push({
        productId: r.productId, sku: r.sku, name: r.name, nameAr: r.nameAr, image: r.image,
        price, cost, margin: round2(margin), marginPct: price > 0 ? round2((margin / price) * 100) : 0,
      });
      if (sold > 0) {
        estProfit += sold * margin;
        revenueWithCost += sold * price;
      }
    }
  }

  dead.sort((a, b) => b.tiedUp - a.tiedUp);
  const belowCost = withCost.filter((m) => m.margin < 0).sort((a, b) => a.margin - b.margin);
  const lowest = [...withCost].sort((a, b) => a.marginPct - b.marginPct).slice(0, topN);

  return {
    deadStock: {
      count: dead.length,
      units: deadUnits,
      tiedUpAtCost: round2(deadAtCost),
      tiedUpAtPrice: round2(deadAtPrice),
      items: dead.slice(0, topN),
    },
    margins: {
      withCost: withCost.length,
      costCoveragePct: skus > 0 ? round2((withCost.length / skus) * 100) : 0,
      belowCost: belowCost.slice(0, topN),
      lowest,
      estProfit: round2(estProfit),
      profitMarginPct: revenueWithCost > 0 ? round2((estProfit / revenueWithCost) * 100) : 0,
    },
    valuation: { skus, units, atCost: round2(atCost), atPrice: round2(atPrice) },
  };
}

/** Fetch + compute. Degrades to an empty report when Supabase isn't reachable. */
export async function getInventoryAnalytics(topN = 12): Promise<{ configured: boolean } & InventoryAnalytics> {
  const empty = computeAnalytics([]);
  const [{ createClient, isSupabaseConfigured }, { fetchAll }] = await Promise.all([
    import("@/lib/supabase/server"),
    import("@/lib/supabase/paginate"),
  ]);
  if (!isSupabaseConfigured()) return { configured: false, ...empty };
  try {
    const rows = await fetchAll(
      createClient(),
      "inventory",
      "product_id, stock_quantity, sold_quantity, products(name_en, name_ar, sku, image_url, price, discount_price, cost)"
    );
    const mapped: AnalyticsRow[] = rows.map((r: any) => {
      const p = r.products || {};
      return {
        productId: r.product_id ?? null,
        sku: p.sku ?? null,
        name: p.name_en ?? p.name_ar ?? null,
        nameAr: p.name_ar ?? null,
        image: p.image_url ?? null,
        stock: Number(r.stock_quantity) || 0,
        sold: Number(r.sold_quantity) || 0,
        price: p.price ?? null,
        discountPrice: p.discount_price ?? null,
        cost: p.cost ?? null,
      };
    });
    return { configured: true, ...computeAnalytics(mapped, topN) };
  } catch {
    return { configured: true, ...empty };
  }
}
