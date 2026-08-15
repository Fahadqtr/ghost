// INV.4D — server-only bridge between the product editor and the Inventory Engine.
//
// The V2 edit action edits product METADATA with the SESSION client (RLS applies).
// Numeric inventory stock, however, moves ONLY through the service-role Inventory
// Engine RPCs. This module builds that narrow, service-role-backed port and runs
// the best-effort transition + audit AFTER the shared save core has produced the
// authoritative before/after. It is created behind the action's auth gate and the
// admin client never leaves the server.
//
// NOT a "use server" module: it is an internal server helper (its exports must not
// become callable endpoints). It performs NO direct inventory table write — every
// quantity change is an Engine call.

import { setAbsolute } from "@/lib/inventory/engine";
import { logAuthoritativeStockTransition } from "@/lib/inventory/transition";
import { insertAuditRow } from "@/lib/audit";
import type { InventoryAdapter, UpdateProductCoreResult } from "@/lib/products/product-save";

/**
 * The numeric-stock port injected into updateProductCore. A simple product's stock
 * change is applied atomically by the Inventory Engine (inv_set_absolute_product),
 * which itself fail-closes on a variant / shelf-tracked product. No direct write.
 */
export function createInventoryAdapter(admin: any): InventoryAdapter {
  return {
    async setAbsolute(inventoryId: string, quantity: number) {
      const res = await setAbsolute(admin, inventoryId, quantity);
      if (!res.ok) return { ok: false, reason: res.reason };
      return {
        ok: true,
        before: Number(res.data.before),
        after: Number(res.data.after),
        productId: (res.data.productId as string | null) ?? null,
      };
    },
  };
}

/**
 * Best-effort authoritative transition + audit for a successful editor save. Uses
 * the authoritative before/after the core reported (from the Engine / the atomic
 * variant rollup) — NEVER totalStock. Never throws and never undoes the save.
 */
export async function applyEditorInventoryEffects(
  admin: any,
  args: {
    productId: string;
    sku: string | null;
    core: Extract<UpdateProductCoreResult, { ok: true }>;
  },
): Promise<void> {
  const { productId, sku, core } = args;
  if (!core.stockChanged) return;

  // Parent / product zero-crossing task (best-effort). For a variant product the
  // before/after are the atomic Σ-variants rollup; for a simple product they are
  // the Engine's before/after. Same authoritative pair either way.
  try {
    await logAuthoritativeStockTransition(admin, {
      productId,
      before: core.stockBefore,
      after: core.stockAfter,
      actor: "product_editor",
    });
  } catch (e) {
    console.error("[editor-inventory-effects] transition failed:", e instanceof Error ? e.message : e);
  }

  // Audit (best-effort, single row per numeric change).
  try {
    if (core.hasVariants) {
      for (const c of core.variantChanges) {
        if (c.kind === "deleted") continue;
        if (Number(c.before) === Number(c.after)) continue;
        await insertAuditRow(admin, {
          agent: "product_editor",
          action: "product_edit_variant_stock",
          action_type: "product_edit_variant_stock",
          sku,
          product_id: productId,
          field: "variant_stock_quantity",
          old_value: String(c.before),
          new_value: String(c.after),
          status: "done",
          details: { variantId: c.variantId, variantName: c.variantName ?? null, kind: c.kind },
        });
      }
    } else {
      await insertAuditRow(admin, {
        agent: "product_editor",
        action: "product_edit_stock",
        action_type: "product_edit_stock",
        sku,
        product_id: productId,
        field: "stock_quantity",
        old_value: String(core.stockBefore),
        new_value: String(core.stockAfter),
        status: "done",
        details: { hasVariants: false },
      });
    }
  } catch (e) {
    console.error("[editor-inventory-effects] audit failed:", e instanceof Error ? e.message : e);
  }
}
