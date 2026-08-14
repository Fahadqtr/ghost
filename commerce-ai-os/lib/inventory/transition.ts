import "server-only";

// INV.3B — unified server-side transition API for the future Inventory Engine.
//
// This is a THIN DELEGATION layer over the existing zero-crossing task logic in
// lib/tasks/stock-tasks.ts. It exists so the Inventory Engine (INV.3C+) has ONE
// import surface for transitions instead of reaching into lib/tasks directly.
//
// Zero-crossing BEHAVIOR IS UNCHANGED — nothing is re-implemented or altered
// here, and NO runtime writer is wired to this module yet. Nothing here writes
// availability (stock_status) or channel state.
//
// DOCUMENTED FINDING (NOT fixed in INV.3B, per scope): `totalStock` sums BOTH
// the product's inventory rows AND its variant rows. For a variant product the
// parent inventory.stock_quantity is itself the rollup Σ(variants), so
// totalStock double-counts variant stock (parent + variants). This only affects
// the zero-crossing threshold (a variant product reads as "in stock" as long as
// either side is > 0, which is the current intended forgiving behavior), so it is
// left exactly as-is here and flagged for a later engine phase to reconcile.

import { openStockTask, openVariantStockTask } from "@/lib/tasks/stock-tasks";
import { planAuthoritativeVariantTransition } from "./variant-transition-plan.ts";
export type { VariantTransitionPlan } from "./variant-transition-plan.ts";
export { planAuthoritativeVariantTransition } from "./variant-transition-plan.ts";

export {
  logStockTransition,
  logVariantStockTransition,
  openStockTask,
  openVariantStockTask,
  totalStock,
} from "@/lib/tasks/stock-tasks";

/** Zero-crossing task action produced by the transition layer. */
export type StockTransitionAction = "oos" | "restock";

// INV.4B — AUTHORITATIVE variant zero-crossing transition.
//
// The legacy logVariantStockTransition re-reads totalStock (parent inventory +
// variants), which double-counts a variant product's stock (INV.3B finding). The
// INV.4B variant writers instead get the parent's authoritative before/after Σ
// variants straight from the atomic Engine RPC, so this surface takes those
// numbers directly and NEVER calls totalStock. It reuses the SAME task openers
// (openStockTask / openVariantStockTask) and the SAME <= 0 zero threshold as the
// legacy path, so the produced tasks are identical — only the (correct) input
// differs. Best-effort: a task failure never undoes the stock mutation. Never
// writes availability (stock_status) or channel state.
//
// The legacy logVariantStockTransition + totalStock are left UNCHANGED for their
// existing callers.
export async function logAuthoritativeVariantTransition(admin: any, opts: {
  productId: string | null | undefined;
  variantId: string;
  variantName: string;
  variantBefore: number;
  variantAfter: number;
  parentBefore: number;
  parentAfter: number;
  actor?: string;
}): Promise<void> {
  try {
    const productId = opts.productId ? String(opts.productId) : "";
    if (!productId) return;
    const plan = planAuthoritativeVariantTransition({
      variantBefore: opts.variantBefore,
      variantAfter: opts.variantAfter,
      parentBefore: opts.parentBefore,
      parentAfter: opts.parentAfter,
    });
    if (plan.level === "none") return;
    if (plan.level === "product") {
      await openStockTask(admin, productId, plan.action, opts.actor);
      return;
    }
    await openVariantStockTask(
      admin, productId,
      { id: opts.variantId, name: opts.variantName },
      plan.action,
      opts.actor,
    );
  } catch (e) {
    console.error("[authoritative-variant-transition]", e instanceof Error ? e.message : e);
  }
}
