// Loads stock snapshots for the RESOLVED targets only, in the exact shape the
// pure planner (buildTalabatDeductionPlan) expects. Data access is dependency-
// injected via an admin client; only TYPES are imported from siblings (erased at
// runtime), so node:test can import it with a fake client.
//
// Fail-closed rules:
//   * NULL / negative values are passed THROUGH unchanged (never coerced to 0) —
//     the planner classifies them as inventory_inconsistent.
//   * DUPLICATE inventory / variant rows are passed THROUGH (never hidden) — the
//     planner classifies a duplicate snapshot as inventory_inconsistent.
//   * ANY query error → { status: "error" } (the caller maps that to
//     inventory_inconsistent). This module NEVER mutates stock.

import type { StockSnapshot, ShelfRow } from "./deduction-plan";

export interface SnapshotTarget {
  masterProductId: string;
  masterVariantSku: string | null; // null = no-variant product
}

export type SnapshotResult =
  | { status: "ok"; snapshots: StockSnapshot[] }
  | { status: "error" };

function toShelves(rows: any[] | null): ShelfRow[] {
  return (rows ?? []).map((r: any) => ({ location: r.location, quantity: r.quantity }));
}

/**
 * Load one snapshot per matching stock row for each resolved target. Duplicate
 * rows produce duplicate snapshots on purpose (the planner rejects them).
 */
export async function loadStockSnapshots(admin: any, targets: SnapshotTarget[]): Promise<SnapshotResult> {
  try {
    const snapshots: StockSnapshot[] = [];
    for (const t of targets) {
      if (t.masterVariantSku !== null) {
        // Variant target: the exact variant row(s) + its shelf rows.
        const { data: vrows, error: vErr } = await admin
          .from("product_variants")
          .select("id, parent_product_id, sku, stock_quantity")
          .eq("parent_product_id", t.masterProductId)
          .eq("sku", t.masterVariantSku);
        if (vErr) return { status: "error" };
        for (const v of vrows ?? []) {
          const { data: srows, error: sErr } = await admin
            .from("variant_shelf_stock")
            .select("location, quantity")
            .eq("variant_id", v.id);
          if (sErr) return { status: "error" };
          snapshots.push({
            kind: "variant",
            masterProductId: t.masterProductId,
            masterVariantSku: t.masterVariantSku,
            variantId: v.id,
            variantStock: v.stock_quantity, // NULL/negative passed through unchanged
            shelves: toShelves(srows),
          } as StockSnapshot);
        }
      } else {
        // No-variant target: the inventory row(s) + its shelf rows.
        const { data: irows, error: iErr } = await admin
          .from("inventory")
          .select("id, product_id, stock_quantity")
          .eq("product_id", t.masterProductId);
        if (iErr) return { status: "error" };
        for (const inv of irows ?? []) {
          const { data: srows, error: sErr } = await admin
            .from("shelf_stock")
            .select("location, quantity")
            .eq("inventory_id", inv.id);
          if (sErr) return { status: "error" };
          snapshots.push({
            kind: "product",
            masterProductId: t.masterProductId,
            inventoryId: inv.id,
            inventoryStock: inv.stock_quantity, // NULL/negative passed through unchanged
            shelves: toShelves(srows),
          } as StockSnapshot);
        }
      }
    }
    return { status: "ok", snapshots };
  } catch {
    return { status: "error" };
  }
}
