// INV.4B — PURE zero-crossing decision for an authoritative variant movement.
//
// Given the AUTHORITATIVE before/after of a variant AND its parent (both produced
// atomically by the Inventory Engine RPC — NOT the double-counting totalStock
// helper), decide which zero-crossing task (if any) to open:
//
//   * the PARENT product crossed zero → a product-level task ("oos"/"restock"),
//     which supersedes any per-variant crossing (the whole product is the story);
//   * else the VARIANT itself crossed zero while the parent still has stock → an
//     option-scoped task;
//   * else nothing crossed → no task.
//
// A quantity is "out" when it is <= 0 (matches the legacy logStockTransition /
// logVariantStockTransition threshold exactly, so behavior is preserved).
//
// PURE — no I/O, no server-only, no `@/` imports. Unit-tested directly. The
// server-side firing (openStockTask / openVariantStockTask) lives in
// lib/inventory/transition.ts (logAuthoritativeVariantTransition), which delegates
// the DECISION to this function.

export type StockTransitionAction = "oos" | "restock";

export type VariantTransitionPlan =
  | { level: "product"; action: StockTransitionAction }
  | { level: "variant"; action: StockTransitionAction }
  | { level: "none" };

const n = (v: unknown): number => Number(v) || 0;
const out = (q: number): boolean => q <= 0;
const crossed = (before: number, after: number): boolean => out(before) !== out(after);

// INV.4C — PURE product-level zero-crossing decision from an authoritative
// before/after (produced atomically by a shelf Engine RPC). Same <= 0 "out"
// threshold as the legacy logStockTransition, so behavior is preserved; the only
// difference is the (correct) authoritative input instead of a totalStock re-read.
export function planStockTransition(opts: {
  before: number;
  after: number;
}): StockTransitionAction | null {
  const before = n(opts.before);
  const after = n(opts.after);
  if (!crossed(before, after)) return null;
  return out(after) ? "oos" : "restock";
}

export function planAuthoritativeVariantTransition(opts: {
  variantBefore: number;
  variantAfter: number;
  parentBefore: number;
  parentAfter: number;
}): VariantTransitionPlan {
  const vb = n(opts.variantBefore);
  const va = n(opts.variantAfter);
  const pb = n(opts.parentBefore);
  const pa = n(opts.parentAfter);

  // Parent crossing wins — the product-level task says it all.
  if (crossed(pb, pa)) {
    return { level: "product", action: out(pa) ? "oos" : "restock" };
  }
  // Parent unchanged across zero, but this one option crossed.
  if (crossed(vb, va)) {
    return { level: "variant", action: out(va) ? "oos" : "restock" };
  }
  return { level: "none" };
}
