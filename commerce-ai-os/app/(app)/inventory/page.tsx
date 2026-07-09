import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import KpiCard from "@/components/KpiCard";
import InventoryTable, { type InventoryRow } from "@/components/InventoryTable";
import InventoryModeToggle from "@/components/InventoryModeToggle";
import SimpleAvailabilityList from "@/components/SimpleAvailabilityList";
import { getInventoryMode } from "@/lib/settings";
import { getT } from "@/lib/i18n-server";

// Count staff movements still awaiting the owner's review (details.review unset).
async function pendingApprovalsCount(): Promise<number> {
  try {
    const { count } = await createAdminClient()
      .from("malak_audit")
      .select("id", { count: "exact", head: true })
      .like("agent", "staff:%")
      .in("action_type", ["stock_in", "stock_out"])
      .filter("details->>review", "is", null);
    return count ?? 0;
  } catch {
    return 0;
  }
}

export const dynamic = "force-dynamic";

const nf = (n: number) => new Intl.NumberFormat("en-US").format(n);

export default async function InventoryPage() {
  const supabase = createClient();
  const { locale } = await getT();
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const pendingApprovals = await pendingApprovalsCount();
  const inventoryMode = await getInventoryMode();
  const simpleMode = inventoryMode === "simple";

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

  // Product variants (options) grouped by parent product, + their per-shelf
  // distribution. Degrades to empty if the tables aren't set up.
  const variantsByProduct: Record<string, any[]> = {};
  const variantPlacements: Record<string, { location: string; quantity: number }[]> = {};
  let hasVariantShelf = false;
  {
    const probeV = await supabase.from("product_variants").select("id").limit(1);
    if (!probeV.error) {
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
          .from("product_variants")
          .select("id, parent_product_id, variant_name, sku, barcode, color, size, stock_quantity")
          .range(from, from + 999);
        if (error) break;
        for (const v of (data ?? []) as any[]) {
          (variantsByProduct[v.parent_product_id] ??= []).push({
            id: v.id,
            variant_name: v.variant_name,
            sku: v.sku,
            barcode: v.barcode,
            color: v.color,
            size: v.size,
            stock_quantity: v.stock_quantity,
          });
        }
        if (!data || data.length < 1000) break;
      }
    }
    if (hasLocation) {
      const probeVS = await supabase.from("variant_shelf_stock").select("id").limit(1);
      hasVariantShelf = !probeVS.error;
      if (hasVariantShelf) {
        for (let from = 0; ; from += 1000) {
          const { data, error } = await supabase
            .from("variant_shelf_stock")
            .select("variant_id, location, quantity")
            .range(from, from + 999);
          if (error) break;
          for (const r of (data ?? []) as any[]) {
            (variantPlacements[r.variant_id] ??= []).push({ location: String(r.location), quantity: r.quantity ?? 0 });
          }
          if (!data || data.length < 1000) break;
        }
      }
    }
  }

  // Fetch ALL rows (Supabase caps each request at 1000 — page through them).
  const rows: InventoryRow[] = [];
  let loadError: string | null = null;
  const PAGE = 1000;
  const sel = `id, product_id, stock_quantity, low_stock_threshold, sold_quantity, updated_at${
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
        product_id: r.product_id ?? null,
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

  // Effective stock per product: when a product is sold as options, its real
  // stock lives on the variants, and the inventory row often reads 0. Sum the
  // variant stock for those products so the KPIs don't under-count them; simple
  // products keep using their inventory row.
  const effectiveStock = (r: InventoryRow): number => {
    const vs = r.product_id ? variantsByProduct[r.product_id] : null;
    if (vs && vs.length > 0) {
      return vs.reduce((s, v) => s + (Number(v.stock_quantity) || 0), 0);
    }
    return r.stock_quantity ?? 0;
  };

  // KPI summary
  const total = rows.length;
  const out = rows.filter((r) => effectiveStock(r) <= 0).length;
  const low = rows.filter((r) => {
    const eff = effectiveStock(r);
    return (
      eff > 0 &&
      r.low_stock_threshold != null &&
      eff <= r.low_stock_threshold
    );
  }).length;
  const units = rows.reduce((s, r) => s + effectiveStock(r), 0);
  const sold = rows.reduce((s, r) => s + (r.sold_quantity ?? 0), 0);

  const categories = Array.from(
    new Set(rows.map((r) => r.category).filter((c): c is string => !!c))
  ).sort();

  // Simple-mode rows: one In/Out flag per product (derived from effective stock)
  // plus its options, each with its own In/Out flag.
  const availabilityRows = rows.map((r) => ({
    id: r.id,
    product_name: r.product_name,
    product_name_ar: r.product_name_ar,
    sku: r.sku,
    image_url: r.image_url,
    in_stock: effectiveStock(r) > 0,
    variants: (r.product_id ? variantsByProduct[r.product_id] ?? [] : []).map((v: any) => ({
      id: String(v.id),
      name: v.variant_name ?? null,
      in_stock: (Number(v.stock_quantity) || 0) > 0,
    })),
  }));

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted">
          {L("مصدر الحقيقة الوحيد للمخزون. عدّل مباشرةً، حدّث دفعة واحدة، استورد/صدّر CSV، وادفع إلى Shopify.", "Single source of stock truth. Edit inline, bulk-update, import/export CSV, and push to Shopify.")}
        </p>
        {/* Sub-pages now live in the sidebar (المخزون / الموظفون groups). Keep
            only a one-tap alert when staff movements are awaiting approval. */}
        {pendingApprovals > 0 ? (
          <Link
            href="/inventory/approvals"
            className="inline-flex items-center gap-1.5 self-start rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 whitespace-nowrap hover:bg-amber-100"
          >
            ✅ {pendingApprovals} {L("بانتظار الاعتماد", "pending approval")}
          </Link>
        ) : null}
      </div>

      <InventoryModeToggle mode={inventoryMode} locale={locale} />

      {loadError ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          {L(`تعذّر تحميل المخزون: ${loadError}. تأكّد أنك مسجّل الدخول (RLS).`, `Couldn’t load inventory: ${loadError}. Make sure you’re signed in (RLS).`)}
        </div>
      ) : simpleMode ? (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <KpiCard title={L("منتجات", "Products")} value={nf(total)} icon="🏷️" />
            <KpiCard title={L("متوفر", "In stock")} value={nf(total - out)} icon="✅" />
            <KpiCard title={L("نافد", "Out of stock")} value={nf(out)} icon="⛔" />
          </div>
          <SimpleAvailabilityList rows={availabilityRows} locale={locale} />
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <KpiCard title={L("أصناف متتبَّعة", "Tracked SKUs")} value={nf(total)} icon="🏷️" />
            <KpiCard title={L("نافد", "Out of stock")} value={nf(out)} icon="⛔" hint={L("الكمية 0 أو فارغة", "Quantity 0 or empty")} />
            <KpiCard title={L("مخزون منخفض", "Low stock")} value={nf(low)} icon="⚠️" hint={L("عند الحد أو أقل", "At or below threshold")} />
            <KpiCard title={L("إجمالي القطع", "Total units")} value={nf(units)} icon="📦" />
            <KpiCard title={L("القطع المباعة", "Units sold")} value={nf(sold)} icon="🧾" />
          </div>

          <InventoryTable
            rows={rows}
            categories={categories}
            slots={slots}
            hasLocation={hasLocation}
            placements={placements}
            hasShelfStock={hasShelfStock}
            variantsByProduct={variantsByProduct}
            variantPlacements={variantPlacements}
            hasVariantShelf={hasVariantShelf}
            locale={locale}
          />
        </>
      )}
    </div>
  );
}
