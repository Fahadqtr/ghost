import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import OutOfStockSection, { type OosItem } from "@/components/OutOfStockSection";

export const dynamic = "force-dynamic";

const PAGE = 1000;

export default async function OutOfStockPage() {
  const supabase = createClient();

  let items: OosItem[] = [];
  let errMsg: string | null = null;

  try {
    // Variant stock summed per parent — a product with options is "out" only
    // when ALL its options are out, so we compare the summed total.
    const variantSum = new Map<string, number>();
    {
      const probe = await supabase.from("product_variants").select("id").limit(1);
      if (!probe.error) {
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await supabase
            .from("product_variants")
            .select("parent_product_id, stock_quantity")
            .range(from, from + PAGE - 1);
          if (error) break;
          for (const v of (data ?? []) as any[]) {
            if (!v.parent_product_id) continue;
            variantSum.set(v.parent_product_id, (variantSum.get(v.parent_product_id) ?? 0) + (v.stock_quantity ?? 0));
          }
          if (!data || data.length < PAGE) break;
        }
      }
    }

    const rows: any[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("inventory")
        .select("product_id, stock_quantity, updated_at, products(name_en, name_ar, sku, image_url, main_category, barcode)")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      rows.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
    }

    for (const r of rows as any[]) {
      const hasVariants = r.product_id && variantSum.has(r.product_id);
      const effective = hasVariants ? variantSum.get(r.product_id)! : (r.stock_quantity ?? 0);
      if (effective > 0) continue; // only out-of-stock
      items.push({
        id: r.product_id,
        name_en: r.products?.name_en ?? null,
        name_ar: r.products?.name_ar ?? null,
        sku: r.products?.sku ?? null,
        barcode: r.products?.barcode ?? null,
        image_url: r.products?.image_url ?? null,
        category: r.products?.main_category ?? null,
        updated_at: r.updated_at ?? null,
      });
    }
    items.sort((a, b) => (a.name_en ?? a.sku ?? "").localeCompare(b.name_en ?? b.sku ?? ""));
  } catch (e) {
    errMsg = e instanceof Error ? e.message : "Failed to load.";
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 print:hidden">
        <div>
          <h2 className="text-lg font-semibold text-ink">المنتجات النافدة · Out of stock</h2>
          <p className="text-sm text-muted">
            قائمة المنتجات اللي مخزونها صفر، مع صورة لكل منتج. صدّرها Excel أو PDF، أو علّم قائمة منتجات نافدة بلصق أسمائها.
          </p>
        </div>
        <Link href="/inventory" className="btn-ghost px-3 py-1 text-xs whitespace-nowrap">← Back to inventory</Link>
      </div>

      {errMsg ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">Couldn’t load: {errMsg}.</div>
      ) : (
        <OutOfStockSection items={items} />
      )}
    </div>
  );
}
