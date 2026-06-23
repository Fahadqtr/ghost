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
  if (!loadError) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("product_variants")
        .select("sku, variant_name, price, barcode, products(name_en, name_ar)")
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
        const name = parent && variant ? `${parent} · ${variant}` : variant ?? parent;
        products.push({
          sku: r.sku ?? null,
          name,
          price: r.price ?? null,
          barcode: String(r.barcode),
        });
      }
      if (!data || data.length < PAGE) break;
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-muted">
          Generate printable barcode labels (Code 128). Add products, set how many copies, then Print.
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
        <BarcodeLabels products={products} />
      )}
    </div>
  );
}
