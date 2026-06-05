import { createClient } from "@/lib/supabase/server";
import InventoryTable, { type InventoryRow } from "@/components/InventoryTable";

export const dynamic = "force-dynamic";

export default async function InventoryPage() {
  const supabase = createClient();

  const { data, error } = await supabase
    .from("inventory")
    .select(
      "id, stock_quantity, low_stock_threshold, sold_quantity, products(name_en, sku)"
    )
    .limit(1000);

  const rows: InventoryRow[] = (data ?? []).map((r: any) => ({
    id: r.id,
    product_name: r.products?.name_en ?? null,
    sku: r.products?.sku ?? null,
    stock_quantity: r.stock_quantity,
    low_stock_threshold: r.low_stock_threshold,
    sold_quantity: r.sold_quantity,
  }));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Single source of stock truth. Edit stock and thresholds inline.</p>
      {error ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          Couldn’t load inventory: {error.message}. Make sure you’re signed in (RLS).
        </div>
      ) : (
        <InventoryTable rows={rows} />
      )}
    </div>
  );
}
