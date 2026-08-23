import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import BarcodeLabels, { type LabelProduct } from "@/components/BarcodeLabels";

export const dynamic = "force-dynamic";

export default async function LabelsPage() {
  const supabase = createClient();

  const products: LabelProduct[] = [];
  let loadError: string | null = null;
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("products")
      .select("sku, name_en, name_ar, price, barcode")
      .not("barcode", "is", null)
      .neq("barcode", "")
      .order("name_en")
      .range(from, from + PAGE - 1);
    if (error) {
      loadError = error.message;
      break;
    }
    for (const r of (data ?? []) as any[]) {
      products.push({
        sku: r.sku ?? null,
        name: r.name_en ?? r.name_ar ?? null,
        price: r.price ?? null,
        barcode: String(r.barcode),
      });
    }
    if (!data || data.length < PAGE) break;
  }

  // Variant-level barcodes — each option gets its own printable label, named
  // "Parent · Variant" so it's easy to find alongside the product barcodes.
  // Parent names are fetched separately (no FK-embed dependency, since
  // parent_product_id may not be a declared foreign key). Variant-load failures
  // are non-fatal so product labels still work.
  if (!loadError) {
    const vrows: any[] = [];
    let vError = false;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("product_variants")
        .select("sku, variant_name, price, barcode, parent_product_id")
        .not("barcode", "is", null)
        .neq("barcode", "")
        .range(from, from + PAGE - 1);
      if (error) {
        vError = true;
        break;
      }
      vrows.push(...((data ?? []) as any[]));
      if (!data || data.length < PAGE) break;
    }
    if (!vError && vrows.length > 0) {
      const parentIds = Array.from(new Set(vrows.map((r) => r.parent_product_id).filter(Boolean)));
      const nameById = new Map<string, string | null>();
      for (let i = 0; i < parentIds.length; i += 300) {
        const chunk = parentIds.slice(i, i + 300);
        const { data } = await supabase.from("products").select("id, name_en, name_ar").in("id", chunk);
        for (const p of (data ?? []) as any[]) nameById.set(p.id, p.name_en ?? p.name_ar ?? null);
      }
      for (const r of vrows) {
        const parent = nameById.get(r.parent_product_id) ?? null;
        const variant = r.variant_name ?? null;
        const name = parent && variant ? `${parent} · ${variant}` : variant ?? parent;
        products.push({
          sku: r.sku ?? null,
          name,
          price: r.price ?? null,
          barcode: String(r.barcode),
        });
      }
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-muted">
          Generate printable barcode labels (Code 128). Add products, set how many copies, then Print.
        </p>
        <Link href="/v2/inventory" className="btn-ghost px-3 py-1 text-xs whitespace-nowrap">
          ← Back to inventory
        </Link>
      </div>

      {loadError ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          Couldn’t load products: {loadError}.
        </div>
      ) : (
        <BarcodeLabels products={products} />
      )}
    </div>
  );
}
