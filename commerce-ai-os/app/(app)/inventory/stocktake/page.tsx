import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import StocktakeCount, { type CountItem } from "@/components/StocktakeCount";

export const dynamic = "force-dynamic";

export default async function StocktakePage() {
  const supabase = createClient();

  // Is the `location` column present yet? (degrade gracefully pre-migration.)
  const probe = await supabase.from("inventory").select("location").limit(1);
  const hasLocation = !probe.error;

  // Defined slots, for assigning locations while counting.
  const slotsRes = hasLocation
    ? await supabase.from("shelf_slots").select("code").order("shelf").order("sort")
    : { data: [] as any[] };
  const slots: string[] = ((slotsRes.data ?? []) as any[]).map((s) => String(s.code));

  // Inventory rows that have a scannable barcode, so a scan maps to a row we can
  // write back to. Page through Supabase's 1000-row cap.
  const items: CountItem[] = [];
  let loadError: string | null = null;
  const PAGE = 1000;
  const sel = `id, stock_quantity${hasLocation ? ", location" : ""}, products!inner(name_en, name_ar, sku, barcode)`;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("inventory")
      .select(sel)
      .not("products.barcode", "is", null)
      .neq("products.barcode", "")
      .range(from, from + PAGE - 1);
    if (error) {
      loadError = error.message;
      break;
    }
    for (const r of (data ?? []) as any[]) {
      items.push({
        inventoryId: r.id,
        barcode: String(r.products?.barcode ?? ""),
        sku: r.products?.sku ?? null,
        name: r.products?.name_en ?? r.products?.name_ar ?? null,
        name_ar: r.products?.name_ar ?? null,
        location: hasLocation ? r.location ?? null : null,
        stock: r.stock_quantity ?? 0,
      });
    }
    if (!data || data.length < PAGE) break;
  }

  // Variant-level barcodes — each option is counted independently and writes back
  // to product_variants.stock_quantity. Skip cleanly if the barcode column hasn't
  // been added yet (pre-migration).
  const vProbe = await supabase.from("product_variants").select("barcode").limit(1);
  const hasVariantBarcode = !vProbe.error;
  if (!loadError && hasVariantBarcode) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("product_variants")
        .select("id, sku, barcode, variant_name, stock_quantity, products!inner(name_en, name_ar)")
        .not("barcode", "is", null)
        .neq("barcode", "")
        .range(from, from + PAGE - 1);
      if (error) {
        loadError = error.message;
        break;
      }
      for (const r of (data ?? []) as any[]) {
        const parent = r.products?.name_en ?? r.products?.name_ar ?? null;
        const variant = r.variant_name ?? null;
        items.push({
          inventoryId: "",
          variantId: r.id,
          barcode: String(r.barcode),
          sku: r.sku ?? null,
          name: parent && variant ? `${parent} · ${variant}` : variant ?? parent,
          name_ar: r.products?.name_ar ?? null,
          location: null,
          stock: r.stock_quantity ?? 0,
        });
      }
      if (!data || data.length < PAGE) break;
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Shelf stocktake — scan each piece with your barcode scanner to count what’s physically on the
          shelf, then review the variance and apply it to inventory.
        </p>
        <Link href="/inventory" className="btn-ghost px-3 py-1 text-xs whitespace-nowrap">
          ← Back to inventory
        </Link>
      </div>

      {loadError ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          Couldn’t load products: {loadError}.
        </div>
      ) : (
        <StocktakeCount items={items} slots={slots} />
      )}
    </div>
  );
}
