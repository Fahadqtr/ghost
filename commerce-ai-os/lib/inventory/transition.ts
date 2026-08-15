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
import { planAuthoritativeVariantTransition, planStockTransition } from "./variant-transition-plan.ts";
export type { VariantTransitionPlan } from "./variant-transition-plan.ts";
export { planAuthoritativeVariantTransition, planStockTransition } from "./variant-transition-plan.ts";

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

// INV.4C — AUTHORITATIVE product zero-crossing transition. Same as the legacy
// logStockTransition but takes the authoritative before/after straight from the
// shelf Engine RPC instead of re-reading totalStock (INV.3B double-count). Opens
// the product-level oos/restock task only on a real zero crossing. Best-effort: a
// task failure never undoes the stock mutation. Never writes availability. The
// legacy logStockTransition + totalStock are left UNCHANGED for their callers.
export async function logAuthoritativeStockTransition(admin: any, opts: {
  productId: string | null | undefined;
  before: number;
  after: number;
  actor?: string;
}): Promise<void> {
  try {
    const productId = opts.productId ? String(opts.productId) : "";
    if (!productId) return;
    const action = planStockTransition({ before: opts.before, after: opts.after });
    if (!action) return;
    await openStockTask(admin, productId, action, opts.actor);
  } catch (e) {
    console.error("[authoritative-stock-transition]", e instanceof Error ? e.message : e);
  }
}

// INV.5 — AUTHORITATIVE VARIANT-ONLY zero-crossing transition. Unlike
// logAuthoritativeVariantTransition (which escalates to a PRODUCT task when the
// parent pool crosses zero), this opens ONLY a variant-level oos/restock task on
// the variant's OWN crossing. A channel sale fires the parent transition ONCE per
// affected product (logAuthoritativeStockTransition); for variants whose parent
// did NOT cross zero it fires this variant-only task — so several variants of one
// parent never produce duplicate parent tasks. Best-effort; never writes
// availability; a task failure never undoes the sale.
export async function logAuthoritativeVariantOnlyTransition(admin: any, opts: {
  productId: string | null | undefined;
  variantId: string;
  variantName: string;
  variantBefore: number;
  variantAfter: number;
  actor?: string;
}): Promise<void> {
  try {
    const productId = opts.productId ? String(opts.productId) : "";
    if (!productId || !opts.variantId) return;
    const action = planStockTransition({ before: opts.variantBefore, after: opts.variantAfter });
    if (!action) return;
    await openVariantStockTask(admin, productId, { id: opts.variantId, name: opts.variantName }, action, opts.actor);
  } catch (e) {
    console.error("[authoritative-variant-only-transition]", e instanceof Error ? e.message : e);
  }
}
