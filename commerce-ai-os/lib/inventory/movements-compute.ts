// Stock-movement arithmetic — pure, DB-free core.
//
// The delta math behind the movement engine (movements.ts): normalize a raw
// quantity, apply an IN/OUT to a stock level (refusing to go negative), and
// compute the inventory effect of editing or deleting a recorded movement.
// Kept free of Supabase/server-only so it is unit-testable; the reads, writes,
// audit rows, and revalidation live in movements.ts.
//
// NOTE ON REASON MATCHING (deliberate, mirrors the original engine exactly):
// a NEW movement counts as a sale case-insensitively ("sale"/"Sale"/"SALE"),
// but edit/delete adjust sold_quantity only for the exact stored "sale" —
// the reason was normalized when the movement was recorded.

// INV.3A: canonical movement-normalization/apply math now lives in compute.ts.
// Re-exporting preserves the existing public API and runtime behavior.
export { normalizeQty, planApply } from "./compute.ts";
export type { ApplyPlan } from "./compute.ts";

export interface EditPlan {
  stockAfter: number;        // clamped at 0
  soldAfter: number | null;  // clamped at 0, or null = don't touch it
  newValue: string | undefined; // audit new_value recomputed from old_value, if numeric
}

/**
 * Effect of changing a recorded movement's quantity from `oldQty` to `newQty`:
 * the stock moves by the delta in the movement's direction, sold_quantity
 * follows for exact-"sale" OUTs, and the audit new_value is recomputed from the
 * row's numeric old_value (undefined when it never was numeric).
 */
export function planEdit(args: {
  dir: "in" | "out";
  reason: string;
  oldQty: number;
  newQty: number;
  stock: number;
  sold: number;
  oldValue: unknown;
}): EditPlan {
  const { dir, reason, oldQty, newQty, stock, sold } = args;
  const deltaQty = newQty - oldQty;
  const stockDelta = dir === "in" ? deltaQty : -deltaQty;
  const stockAfter = Math.max(0, (Number(stock) || 0) + stockDelta);
  const soldAfter = dir === "out" && reason === "sale" ? Math.max(0, (Number(sold) || 0) + deltaQty) : null;
  const oldVal = Number(args.oldValue);
  const newValue = Number.isFinite(oldVal) ? String(oldVal + (dir === "in" ? newQty : -newQty)) : undefined;
  return { stockAfter, soldAfter, newValue };
}

export interface DeletePlan {
  stockAfter: number;       // clamped at 0
  soldAfter: number | null; // clamped at 0, or null = don't touch it
}

/**
 * Effect of deleting a recorded movement: undo its stock effect (an IN comes
 * back out, an OUT goes back in), and roll back sold_quantity for
 * exact-"sale" OUTs.
 */
export function planDelete(args: {
  dir: "in" | "out";
  reason: string;
  qty: number;
  stock: number;
  sold: number;
}): DeletePlan {
  const { dir, reason, qty, stock, sold } = args;
  const stockDelta = dir === "in" ? -qty : qty;
  const stockAfter = Math.max(0, (Number(stock) || 0) + stockDelta);
  const soldAfter = dir === "out" && reason === "sale" ? Math.max(0, (Number(sold) || 0) - qty) : null;
  return { stockAfter, soldAfter };
}
