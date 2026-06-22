import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import KpiCard from "@/components/KpiCard";
import InventoryTable, { type InventoryRow } from "@/components/InventoryTable";

export const dynamic = "force-dynamic";

const nf = (n: number) => new Intl.NumberFormat("en-US").format(n);

export default async function InventoryPage() {
  const supabase = createClient();

  // Is the `location` column present yet? (degrade gracefully pre-migration.)
  const probe = await supabase.from("inventory").select("location").limit(1);
  const hasLocation = !probe.error;

  // Shelf map for the location dropdown + filter (empty if not set up yet).
  const slotsRes = hasLocation
    ? await supabase.from("shelf_slots").select("code").order("shelf").order("sort")
    : { data: [] as any[], error: null };
  const slots: string[] = ((slotsRes.data ?? []) as any[]).map((s) => String(s.code));

  // Per-shelf distribution (a product can sit in several shelves). Map by row.
  const placements: Record<string, { location: string; quantity: number }[]> = {};
  let hasShelfStock = false;
  if (hasLocation) {
    const probeSS = await supabase.from("shelf_stock").select("id").limit(1);
    hasShelfStock = !probeSS.error;
    if (hasShelfStock) {
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
          .from("shelf_stock")
          .select("inventory_id, location, quantity")
          .range(from, from + 999);
        if (error) break;
        for (const r of (data ?? []) as any[]) {
          (placements[r.inventory_id] ??= []).push({ location: String(r.location), quantity: r.quantity ?? 0 });
        }
        if (!data || data.length < 1000) break;
      }
    }
  }

  // Fetch ALL rows (Supabase caps each request at 1000 — page through them).
  const rows: InventoryRow[] = [];
  let loadError: string | null = null;
  const PAGE = 1000;
  const sel = `id, stock_quantity, low_stock_threshold, sold_quantity, updated_at${
    hasLocation ? ", location" : ""
  }, products(name_en, name_ar, sku, image_url, main_category, barcode)`;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("inventory")
      .select(sel)
      .order("stock_quantity", { ascending: true, nullsFirst: true })
      .range(from, from + PAGE - 1);

    if (error) {
      loadError = error.message;
      break;
    }
    for (const r of (data ?? []) as any[]) {
      rows.push({
        id: r.id,
        product_name: r.products?.name_en ?? null,
        product_name_ar: r.products?.name_ar ?? null,
        sku: r.products?.sku ?? null,
        barcode: r.products?.barcode ?? null,
        location: hasLocation ? r.location ?? null : null,
        image_url: r.products?.image_url ?? null,
        category: r.products?.main_category ?? null,
        stock_quantity: r.stock_quantity,
        low_stock_threshold: r.low_stock_threshold,
        sold_quantity: r.sold_quantity,
        updated_at: r.updated_at ?? null,
      });
    }
    if (!data || data.length < PAGE) break;
  }

  // KPI summary
  const total = rows.length;
  const out = rows.filter((r) => (r.stock_quantity ?? 0) <= 0).length;
  const low = rows.filter(
    (r) =>
      r.stock_quantity != null &&
      r.stock_quantity > 0 &&
      r.low_stock_threshold != null &&
      r.stock_quantity <= r.low_stock_threshold
  ).length;
  const units = rows.reduce((s, r) => s + (r.stock_quantity ?? 0), 0);
  const sold = rows.reduce((s, r) => s + (r.sold_quantity ?? 0), 0);

  const categories = Array.from(
    new Set(rows.map((r) => r.category).filter((c): c is string => !!c))
  ).sort();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Single source of stock truth. Edit inline, bulk-update, import/export CSV, and push to Shopify.
        </p>
        <div className="flex flex-none gap-2">
          <Link href="/inventory/shelves" className="btn-ghost px-3 py-1 text-xs whitespace-nowrap">
            🗄️ Shelves
          </Link>
          <Link href="/inventory/stocktake" className="btn-ghost px-3 py-1 text-xs whitespace-nowrap">
            📦 Count shelf
          </Link>
          <Link href="/inventory/labels" className="btn-ghost px-3 py-1 text-xs whitespace-nowrap">
            🖨️ Barcodes
          </Link>
          <Link href="/inventory/movements" className="btn-ghost px-3 py-1 text-xs whitespace-nowrap">
            Stock IN / OUT →
          </Link>
        </div>
      </div>

      {loadError ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          Couldn’t load inventory: {loadError}. Make sure you’re signed in (RLS).
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <KpiCard title="Tracked SKUs" value={nf(total)} icon="🏷️" />
            <KpiCard title="Out of stock" value={nf(out)} icon="⛔" hint="Quantity 0 or empty" />
            <KpiCard title="Low stock" value={nf(low)} icon="⚠️" hint="At or below threshold" />
            <KpiCard title="Total units" value={nf(units)} icon="📦" />
            <KpiCard title="Units sold" value={nf(sold)} icon="🧾" />
          </div>

          <InventoryTable
            rows={rows}
            categories={categories}
            slots={slots}
            hasLocation={hasLocation}
            placements={placements}
            hasShelfStock={hasShelfStock}
          />
        </>
      )}
    </div>
  );
}
