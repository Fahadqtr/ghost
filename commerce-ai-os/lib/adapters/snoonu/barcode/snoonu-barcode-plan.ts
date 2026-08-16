// CH.6D — barcode apply planning + idempotency / stale-preview protection (PURE).
//
// From a FRESH re-scan (rows) + the operator's selection + a fresh read of
// internal state at apply time, decide the per-target plan. A target only
// proceeds when it is STILL AUTO_COMPLETABLE, its internal barcode is STILL
// empty, and no new internal owner has appeared for the incoming barcode. Any
// drift since the preview downgrades it to unchanged / needs_review — the
// orchestrator never overwrites newer data (§12).
//
// PURE: imports only pure siblings. node:test loads it.

import { type BarcodeDiffRow, type TargetKind } from "./snoonu-barcode-diff.ts";

export type PlanAction = "apply" | "skip" | "unchanged" | "needs_review";

export interface BarcodePlanItem {
  targetKind: TargetKind;
  productId: string;
  variantId: string | null;
  incoming: string | null;
  action: PlanAction;
  reason: string;
}

export interface BarcodePlanInput {
  /** FRESH re-scan rows at apply time. */
  rows: BarcodeDiffRow[];
  /** Selected target keys (see targetKey). */
  selected: Set<string>;
  /** FRESH internal barcode at apply time: targetKey → current barcode (or null). */
  currentNow: Map<string, string | null>;
  /** FRESH ownership: is the barcode owned by a DIFFERENT internal item now? */
  isOwnedByOther: (barcode: string, targetKey: string) => boolean;
}

/** Stable identity key for a sellable target (variant grain wins when present). */
export function targetKey(t: { targetKind: TargetKind; productId: string; variantId: string | null }): string {
  return t.targetKind === "variant" && t.variantId ? `variant:${t.variantId}` : `product:${t.productId}`;
}

export function planBarcodeApply(input: BarcodePlanInput): BarcodePlanItem[] {
  const out: BarcodePlanItem[] = [];
  for (const r of input.rows) {
    const key = targetKey(r);
    if (!input.selected.has(key)) continue;
    const id = { targetKind: r.targetKind, productId: r.productId, variantId: r.variantId };

    if (r.status !== "AUTO_COMPLETABLE" || !r.incoming) {
      out.push({ ...id, incoming: null, action: "skip", reason: `no longer auto-completable (${r.status})` });
      continue;
    }
    if ((input.currentNow.get(key) ?? null) !== null) {
      out.push({ ...id, incoming: null, action: "unchanged", reason: "internal barcode was filled since preview" });
      continue;
    }
    if (input.isOwnedByOther(r.incoming, key)) {
      out.push({ ...id, incoming: r.incoming, action: "needs_review", reason: "a different internal item now owns this barcode" });
      continue;
    }
    out.push({ ...id, incoming: r.incoming, action: "apply", reason: r.reason });
  }
  return out;
}
