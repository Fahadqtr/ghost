import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import ProductTable, { type ProductRow } from "@/components/ProductTable";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const supabase = createClient();

  // Products with brand name and variant count (embedded selects via FKs).
  const { data, error } = await supabase
    .from("products")
    .select(
      "id, sku, name_en, main_category, price, stock_quantity, stock_status, brands(name), product_variants(count)"
    )
    .order("created_at", { ascending: false })
    .limit(500);

  const products: ProductRow[] = (data ?? []).map((p: any) => ({
    id: p.id,
    sku: p.sku,
    name_en: p.name_en,
    brand_name: p.brands?.name ?? null,
    main_category: p.main_category,
    price: p.price,
    stock_quantity: p.stock_quantity,
    stock_status: p.stock_status,
    variant_count: p.product_variants?.[0]?.count ?? 0,
  }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">Manage your product catalog (mirror of the 28-column master sheet).</p>
        <Link href="/products/new" className="btn-primary">+ New product</Link>
      </div>

      {error ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          Couldn’t load products: {error.message}. Make sure you’re signed in (RLS).
        </div>
      ) : (
        <ProductTable products={products} />
      )}
    </div>
  );
}
