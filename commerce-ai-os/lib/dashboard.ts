// Dashboard KPI data layer (server-only).
// Every query is defensive: any failure (missing table/column, empty data,
// unconfigured Supabase) resolves to null/empty so the UI shows a clean
// "No data yet" state instead of crashing.
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";

export interface TopProduct {
  name: string;
  sold: number | null;
}

export interface DashboardKpis {
  configured: boolean;
  productsTotal: number | null;
  ordersToday: number | null;
  salesToday: number | null;
  lowStock: number | null;
  missingImages: number | null;
  topProducts: TopProduct[];
  alerts: string[];
}

function startOfTodayIso(): string {
  return new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
}

// Pick the first plausible numeric "total" field present on an order row.
const TOTAL_FIELDS = ["total", "total_amount", "amount", "grand_total", "price"];
function orderTotal(row: Record<string, unknown>): number {
  for (const f of TOTAL_FIELDS) {
    const v = row[f];
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)))
      return Number(v);
  }
  return 0;
}

export async function getDashboardKpis(): Promise<DashboardKpis> {
  const result: DashboardKpis = {
    configured: isSupabaseConfigured(),
    productsTotal: null,
    ordersToday: null,
    salesToday: null,
    lowStock: null,
    missingImages: null,
    topProducts: [],
    alerts: [],
  };

  if (!result.configured) return result;

  const supabase = createClient();

  // Run independently so one failure never blocks the others.
  const [
    productsTotal,
    missingImages,
    inventoryRows,
    ordersToday,
    topProducts,
  ] = await Promise.all([
    safeCount(() =>
      supabase.from("products").select("*", { count: "exact", head: true })
    ),
    safeCount(() =>
      supabase
        .from("products")
        .select("*", { count: "exact", head: true })
        .is("image_url", null)
    ),
    safe(async () =>
      supabase
        .from("inventory")
        .select("stock_quantity, low_stock_threshold")
        .limit(2000)
    ),
    safe(async () =>
      supabase
        .from("orders")
        .select("*")
        .gte("created_at", startOfTodayIso())
        .limit(2000)
    ),
    safe(async () =>
      supabase
        .from("inventory")
        .select("sold_quantity, products(name_en)")
        .order("sold_quantity", { ascending: false })
        .limit(5)
    ),
  ]);

  result.productsTotal = productsTotal;
  result.missingImages = missingImages;

  // Low stock computed in JS (REST can't compare two columns directly).
  if (inventoryRows) {
    result.lowStock = inventoryRows.filter(
      (r: any) =>
        r.stock_quantity != null &&
        r.low_stock_threshold != null &&
        Number(r.stock_quantity) <= Number(r.low_stock_threshold)
    ).length;
  }

  // Orders + sales today.
  if (ordersToday) {
    result.ordersToday = ordersToday.length;
    result.salesToday = ordersToday.reduce(
      (sum: number, row: any) => sum + orderTotal(row),
      0
    );
  }

  // Top products by units sold.
  if (topProducts) {
    result.topProducts = topProducts
      .map((r: any) => ({
        name: r.products?.name_en ?? "Unnamed product",
        sold: r.sold_quantity ?? null,
      }))
      .filter((p: TopProduct) => p.sold != null && Number(p.sold) > 0);
  }

  // Derived alerts.
  if (result.lowStock && result.lowStock > 0)
    result.alerts.push(`${result.lowStock} product(s) low on stock`);
  if (result.missingImages && result.missingImages > 0)
    result.alerts.push(`${result.missingImages} product(s) missing images`);

  return result;
}

// --- helpers --------------------------------------------------------------

async function safe<T>(
  fn: () => PromiseLike<{ data: T | null; error: unknown }>
) {
  try {
    const { data, error } = await fn();
    if (error) return null;
    return data;
  } catch {
    return null;
  }
}

async function safeCount(
  fn: () => PromiseLike<{ count: number | null; error: unknown }>
): Promise<number | null> {
  try {
    const { count, error } = await fn();
    if (error) return null;
    return count ?? null;
  } catch {
    return null;
  }
}
