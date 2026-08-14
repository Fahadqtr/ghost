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

export {
  logStockTransition,
  logVariantStockTransition,
  openStockTask,
  openVariantStockTask,
  totalStock,
} from "@/lib/tasks/stock-tasks";

/** Zero-crossing task action produced by the transition layer. */
export type StockTransitionAction = "oos" | "restock";
