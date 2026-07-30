// Pure Talabat deduction planner. NO Supabase, NO network, NO DB writes — it
// only decides WHAT to deduct (all-or-nothing) from stock snapshots. The atomic
// apply (locking, re-checks, ledger, rollup) is the SQL RPC
// (supabase/talabat_order_atomic_processing.sql). Self-contained for node:test.
//
// Rules: a product with variants deducts ONLY from the matched variant (never
// the generic parent). inventory.stock_quantity is the SUM of its variants
// (never max(parent, variants)). Quantities never go negative. Any shortfall or
// variant/shelf inconsistency ⇒ the WHOLE order is manual_review (no partial).

export interface TargetInput {
  masterProductId: string;
  masterVariantSku: string | null;   // null = no-variant product
  quantity: number;
  lineKeys?: string[];
}

export interface ShelfRow { location: string; quantity: number; }

export interface NoVariantStock {
  kind: "product";
  masterProductId: string;
  inventoryId: string;
  inventoryStock: number;
  shelves?: ShelfRow[];              // shelf_stock rows (optional)
}
export interface VariantStock {
  kind: "variant";
  masterProductId: string;
  masterVariantSku: string;
  variantId: string;
  variantStock: number;
  shelves?: ShelfRow[];              // variant_shelf_stock rows (optional)
}
export type StockSnapshot = NoVariantStock | VariantStock;

export interface ShelfDeduction { location: string; deduct: number; }
export interface DeductionTarget {
  masterProductId: string;
  masterVariantSku: string | null;
  quantity: number;
  shelfPlan: ShelfDeduction[];       // empty when there are no shelf rows
  lineKeys: string[];
}

export type TalabatDeductionReason = "insufficient_stock" | "inventory_inconsistent";

export type TalabatDeductionPlan =
  | { status: "ready"; deductions: DeductionTarget[]; resolution: Record<string, unknown> }
  | { status: "manual_review"; reason: TalabatDeductionReason; resolution: Record<string, unknown> };

const intOf = (v: unknown): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : 0;
};
const keyOf = (pid: string, vsku: string | null): string => `${pid}||${vsku ?? ""}`;

/** inventory.stock_quantity rollup = SUM of the product's variant stock. */
export function sumVariantStock(variantStocks: Array<{ stock_quantity: number | null | undefined }>): number {
  return (variantStocks ?? []).reduce((s, v) => s + Math.max(0, intOf(v.stock_quantity)), 0);
}

/** Spread a deduction across shelves, biggest-first, never below zero. */
export function spreadAcrossShelves(shelves: ShelfRow[], qty: number): ShelfDeduction[] {
  const out: ShelfDeduction[] = [];
  let remaining = Math.max(0, intOf(qty));
  for (const r of [...shelves].sort((a, b) => intOf(b.quantity) - intOf(a.quantity))) {
    if (remaining <= 0) break;
    const have = Math.max(0, intOf(r.quantity));
    if (!have) continue;
    const take = Math.min(have, remaining);
    out.push({ location: r.location, deduct: take });
    remaining -= take;
  }
  return out;
}

/**
 * Build an all-or-nothing deduction plan. Verifies EVERY target first; if any is
 * missing/mismatched (inventory_inconsistent) or short on stock
 * (insufficient_stock) the whole order is manual_review and nothing is deducted.
 */
export function buildTalabatDeductionPlan(targets: TargetInput[], stock: StockSnapshot[]): TalabatDeductionPlan {
  const byKey = new Map<string, StockSnapshot>();
  for (const s of stock) {
    const k = s.kind === "variant" ? keyOf(s.masterProductId, s.masterVariantSku) : keyOf(s.masterProductId, null);
    byKey.set(k, s);
  }

  const deductions: DeductionTarget[] = [];

  for (const t of targets) {
    const qty = intOf(t.quantity);
    if (qty <= 0) {
      return { status: "manual_review", reason: "inventory_inconsistent", resolution: { failed: keyOf(t.masterProductId, t.masterVariantSku), detail: "non_positive_quantity" } };
    }
    const snap = byKey.get(keyOf(t.masterProductId, t.masterVariantSku));

    // Missing snapshot, or a variant target that isn't a variant snapshot (and
    // vice-versa) ⇒ data inconsistency, no deduction.
    if (!snap) return { status: "manual_review", reason: "inventory_inconsistent", resolution: { failed: keyOf(t.masterProductId, t.masterVariantSku), detail: "no_stock_snapshot" } };
    if (t.masterVariantSku !== null && snap.kind !== "variant") return { status: "manual_review", reason: "inventory_inconsistent", resolution: { failed: keyOf(t.masterProductId, t.masterVariantSku), detail: "expected_variant_stock" } };
    if (t.masterVariantSku === null && snap.kind !== "product") return { status: "manual_review", reason: "inventory_inconsistent", resolution: { failed: keyOf(t.masterProductId, t.masterVariantSku), detail: "expected_product_stock" } };

    const available = snap.kind === "variant" ? Math.max(0, intOf(snap.variantStock)) : Math.max(0, intOf(snap.inventoryStock));

    // Variant/shelf consistency: when shelf rows exist their sum must equal the
    // headline stock — a mismatch blocks auto-deduction.
    if (snap.shelves && snap.shelves.length > 0) {
      const shelfSum = snap.shelves.reduce((s, r) => s + Math.max(0, intOf(r.quantity)), 0);
      if (shelfSum !== available) {
        return { status: "manual_review", reason: "inventory_inconsistent", resolution: { failed: keyOf(t.masterProductId, t.masterVariantSku), detail: "variant_shelf_mismatch" } };
      }
    }

    if (qty > available) {
      return { status: "manual_review", reason: "insufficient_stock", resolution: { failed: keyOf(t.masterProductId, t.masterVariantSku), need: qty, have: available } };
    }

    deductions.push({
      masterProductId: t.masterProductId,
      masterVariantSku: t.masterVariantSku,
      quantity: qty,
      shelfPlan: snap.shelves && snap.shelves.length > 0 ? spreadAcrossShelves(snap.shelves, qty) : [],
      lineKeys: t.lineKeys ?? [],
    });
  }

  return { status: "ready", deductions, resolution: { deductions } };
}

// ---- Manual-review payload (safe) -------------------------------------------

export interface ManualReviewInput {
  orderId: string;
  orderCode?: string | null;
  reason: string;
  lineKeys?: string[];
  candidates?: Array<{ lineKey: string; reason?: string; sku?: string | null; barcode?: string | null; channelProductId?: string | null }>;
}

/**
 * Build a safe payload for a future staff_tasks (kind='talabat_review') row.
 * Includes only classified, non-secret data — never the raw webhook, customer
 * phone/address, tokens, or DB errors.
 */
export function buildManualReviewPayload(input: ManualReviewInput): Record<string, unknown> {
  return {
    kind: "talabat_review",
    orderId: input.orderId,
    orderCode: input.orderCode ?? null,
    reason: input.reason,
    lineKeys: input.lineKeys ?? [],
    candidates: (input.candidates ?? []).map((c) => ({
      lineKey: c.lineKey,
      reason: c.reason ?? null,
      sku: c.sku ?? null,
      barcode: c.barcode ?? null,
      channelProductId: c.channelProductId ?? null,
    })),
  };
}
