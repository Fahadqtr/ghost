import { createClient } from "@/lib/supabase/server";
import ProductTable, { type ProductRow } from "@/components/ProductTable";
import Link from "next/link";

export const dynamic = "force-dynamic";

const PAGE = 1000;
async function fetchAll(q: (from: number, to: number) => any): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await q(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  return out;
}

export default async function ProductsPage() {
  const supabase = createClient();

  let products: ProductRow[] = [];
  let errMsg: string | null = null;

  try {
    const [rows, channels, links] = await Promise.all([
      fetchAll((from, to) =>
        supabase
          .from("products")
          .select(
            "id, sku, snoonu_id, barcode, name_en, name_ar, main_category, price, discount_price, product_variants(count), inventory(stock_quantity)"
          )
          .order("sku", { ascending: true })
          .range(from, to)
      ),
      supabase.from("channels").select("id, name"),
      fetchAll((from, to) =>
        supabase.from("channel_products").select("product_id, channel_id, channel_status").range(from, to)
      ),
    ]);

    const chanList = (channels as any).data ?? [];
    const idToName = new Map<string, string>(chanList.map((c: any) => [c.id, c.name]));

    // product_id -> { channelName: status }
    const statusByProduct = new Map<string, Record<string, string>>();
    for (const l of links) {
      const name = idToName.get(l.channel_id);
      if (!name) continue;
      if (!statusByProduct.has(l.product_id)) statusByProduct.set(l.product_id, {});
      statusByProduct.get(l.product_id)![name] = l.channel_status ?? "Not Listed";
    }

    products = rows.map((p: any) => ({
      id: p.id,
      sku: p.sku,
      snoonu_id: p.snoonu_id,
      barcode: p.barcode,
      name_en: p.name_en,
      name_ar: p.name_ar,
      main_category: p.main_category,
      price: p.price,
      discount_price: p.discount_price,
      stock: p.inventory?.[0]?.stock_quantity ?? null,
      variant_count: p.product_variants?.[0]?.count ?? 0,
      channels: statusByProduct.get(p.id) ?? {},
    }));
  } catch (e) {
    errMsg = e instanceof Error ? e.message : "Failed to load products.";
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted">Manage your product catalog (mirror of the 28-column master sheet).</p>
        <Link href="/products/new" className="btn-primary w-full sm:w-auto">+ New product</Link>
      </div>

      {errMsg ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          Couldn’t load products: {errMsg}. Make sure you’re signed in (RLS).
        </div>
      ) : (
        <ProductTable products={products} />
      )}
    </div>
  );
}
