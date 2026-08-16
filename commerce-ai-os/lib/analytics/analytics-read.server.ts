// BI.1 — Analytics Read Layer (server assembler).
//
// The single read-only entrypoint (`loadAnalytics`) that every management surface
// calls exactly once. It composes already-existing, canonical engines — it does
// NOT re-derive any metric, mutate anything, add schema, or run a scheduled job:
//
//   • ONE inventory scan (the only unavoidable table scan) feeds THREE pure
//     canonical computers — computeAnalytics (valuation / dead stock),
//     computeSalesSummary (lifetime totals) and computeLowStock (low / out) — so
//     the inventory table is read once, not three times.
//   • getCeoKpis() is the canonical KPI / catalog-quality reader; BI.1 reuses it
//     for product / channel / missing-field counts rather than re-counting them.
//   • Two cheap COUNT-only head queries add "missing description / keywords"
//     (English field) and "needs mapping" (ECL needs_review); any that error or
//     are unavailable degrade to null → UNKNOWN.
//
// Read access follows the existing signed-in Supabase policy (session client).
// Nothing here writes; the pure `buildAnalyticsSnapshot` shapes the result.

import "server-only";

import { fetchAll } from "@/lib/supabase/paginate";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { computeAnalytics, type AnalyticsRow } from "@/lib/inventory/analytics";
import { computeSalesSummary, type SalesRow } from "@/lib/inventory/sales-compute";
import { computeLowStock, type LowStockRow } from "@/lib/inventory/lowStock-compute";
import { getCeoKpis } from "@/lib/dashboard";
import {
  buildAnalyticsSnapshot,
  type AnalyticsSnapshot,
  type AnalyticsReadInput,
} from "./analytics-read";

const INVENTORY_COLS =
  "product_id, stock_quantity, sold_quantity, low_stock_threshold, products(name_en, name_ar, sku, image_url, price, discount_price, cost)";

/** COUNT-only head query; returns null (→ UNKNOWN) on any error or missing column. */
async function headCount(
  sb: ReturnType<typeof createClient>,
  table: string,
  apply: (b: any) => any,
): Promise<number | null> {
  try {
    const b = sb.from(table).select("id", { count: "exact", head: true });
    const { count, error } = await apply(b);
    if (error) return null;
    return count ?? 0;
  } catch {
    return null;
  }
}

/**
 * Load the read-only analytics snapshot. Composes canonical engines only; never
 * mutates, never adds schema, never schedules. `now` is injected for determinism.
 */
export async function loadAnalytics(now: Date = new Date()): Promise<AnalyticsSnapshot> {
  const generatedAt = now.toISOString();

  if (!isSupabaseConfigured()) {
    return buildAnalyticsSnapshot({ configured: false, generatedAt });
  }

  const sb = createClient();

  // ── ONE inventory scan → three canonical pure computers ──────────────────────
  let invRows: any[] = [];
  try {
    invRows = await fetchAll(sb, "inventory", INVENTORY_COLS);
  } catch {
    invRows = [];
  }

  const analyticsRows: AnalyticsRow[] = invRows.map((r: any) => {
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

  const inv = computeAnalytics(analyticsRows);
  const sales = computeSalesSummary(invRows as SalesRow[], 0);
  const low = computeLowStock(invRows as LowStockRow[], 0);

  // ── Canonical KPI / catalog-quality reader (reused, not re-derived) ──────────
  const kpis = await getCeoKpis();

  // ── Cheap COUNT-only head queries (UNKNOWN on failure) ───────────────────────
  const [missingDescription, missingKeywords, needsMapping] = await Promise.all([
    headCount(sb, "products", (b) => b.or("description_en.is.null,description_en.eq.")),
    headCount(sb, "products", (b) => b.or("keywords_en.is.null,keywords_en.eq.")),
    headCount(sb, "external_channel_listings", (b) => b.eq("mapping_status", "needs_review")),
  ]);

  const input: AnalyticsReadInput = {
    configured: true,
    generatedAt,
    inventory: {
      valuation: inv.valuation,
      deadStock: { count: inv.deadStock.count, units: inv.deadStock.units },
    },
    lowStock: { lowCount: low.lowCount, outCount: low.outCount },
    lifetimeSales: {
      totalUnits: sales.totalUnits,
      totalRevenue: sales.totalRevenue,
      distinctProducts: sales.distinctProducts,
    },
    catalog: {
      totalProducts: kpis.totalProducts,
      activeChannels: kpis.publishedChannels,
      inventoryUnits: kpis.inventoryUnits,
      missingImages: kpis.missingImage,
      missingBarcode: kpis.missingBarcode,
      missingCategory: kpis.missingCategory,
      missingPrice: kpis.missingPrice,
      missingDescription,
      missingKeywords,
      needsMapping,
    },
  };

  return buildAnalyticsSnapshot(input);
}
