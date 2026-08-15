// INV.6A — canonical total sellable stock of a product (no double-count).
//
// Extracted from stock-tasks.ts so it can be unit-tested directly (it takes the
// admin client, imports no framework/@- alias, and does only reads):
//   VARIANT product → total = Σ variant stock. The parent inventory.stock_quantity
//     IS that rollup, so it must NEVER be added again (the old parent + variants
//     double-counted a valid variant product).
//   SIMPLE product  → total = inventory.stock_quantity.

export async function totalStock(admin: any, productId: string): Promise<number> {
  // A variant product's authority is Σ variants; if it has any variant rows we
  // use them and ignore the parent inventory row (which just mirrors the rollup).
  try {
    const { data: vars } = await admin.from("product_variants").select("stock_quantity").eq("parent_product_id", productId);
    const vrows = (vars ?? []) as { stock_quantity: number | null }[];
    if (vrows.length > 0) {
      let sum = 0;
      for (const r of vrows) sum += Number(r.stock_quantity) || 0;
      return sum;
    }
  } catch { /* variants table optional → fall through to the simple total */ }

  let total = 0;
  const { data: inv } = await admin.from("inventory").select("stock_quantity").eq("product_id", productId);
  for (const r of (inv ?? []) as { stock_quantity: number | null }[]) total += Number(r.stock_quantity) || 0;
  return total;
}
