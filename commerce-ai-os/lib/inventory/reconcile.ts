import "server-only";
import { reconcileProduct } from "./reconcile-compute.ts";
import type { ReconcileResult } from "./reconcile-compute.ts";

// INV.3B — reconcile(productId): READ + DERIVE ONLY.
//
// Reads inventory, product_variants, shelf_stock and variant_shelf_stock for one
// product and returns the pure reconciliation verdict (reconcile-compute.ts). It:
//   • performs NO writes — no UPDATE / INSERT / DELETE, never repairs data;
//   • never reads products.stock_quantity (stale mirror);
//   • never touches availability (no stock_status read/write, no availability API);
//   • treats variant / shelf tables as optional (missing table ⇒ empty).
// The caller supplies an already-authorized Supabase client (service-role or RLS).

export type { ReconcileResult } from "./reconcile-compute.ts";

export async function reconcile(admin: any, productId: string): Promise<ReconcileResult> {
  // Product inventory pool (usually exactly one row).
  const { data: invData } = await admin
    .from("inventory")
    .select("id, stock_quantity")
    .eq("product_id", productId);
  const inventoryRows = (invData ?? []) as Array<{ id: string; stock_quantity: number | null }>;
  const inventoryIds = inventoryRows.map((r) => r.id).filter(Boolean);

  // Variants (table optional in some environments).
  let variants: Array<{ id: string; stock_quantity: number | null }> = [];
  try {
    const { data } = await admin
      .from("product_variants")
      .select("id, stock_quantity")
      .eq("parent_product_id", productId);
    variants = (data ?? []) as Array<{ id: string; stock_quantity: number | null }>;
  } catch { /* product_variants optional */ }
  const variantIds = variants.map((v) => v.id).filter(Boolean);

  // Product-level shelf placements (shelf_stock links via inventory_id).
  let shelfStock: Array<{ location: string; quantity: number | null }> = [];
  if (inventoryIds.length) {
    try {
      const { data } = await admin
        .from("shelf_stock")
        .select("inventory_id, location, quantity")
        .in("inventory_id", inventoryIds);
      shelfStock = (data ?? []) as Array<{ location: string; quantity: number | null }>;
    } catch { /* shelf_stock optional */ }
  }

  // Variant-level shelf placements (variant_shelf_stock links via variant_id).
  let variantShelfStock: Array<{ variant_id: string; location: string; quantity: number | null }> = [];
  if (variantIds.length) {
    try {
      const { data } = await admin
        .from("variant_shelf_stock")
        .select("variant_id, location, quantity")
        .in("variant_id", variantIds);
      variantShelfStock = (data ?? []) as Array<{ variant_id: string; location: string; quantity: number | null }>;
    } catch { /* variant_shelf_stock optional */ }
  }

  return reconcileProduct({ productId, inventoryRows, variants, shelfStock, variantShelfStock });
}
