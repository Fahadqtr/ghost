// Pure Talabat deduction planner. NO Supabase, NO network, NO DB writes — it
// only decides WHAT to deduct (all-or-nothing) from stock snapshots. The atomic
// apply (locking, re-checks, ledger, rollup) is the SQL RPC
// (supabase/talabat_order_atomic_processing.sql). Self-contained for node:test.
//
// Rules: a product with variants deducts ONLY from the matched variant (never
// the generic parent). inventory.stock_quantity is the SUM of its variants
// (never max(parent, variants)). Quantities are validated STRICTLY (never
// floored). Any shortfall, malformed quantity, negative/duplicate stock, or
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
  shelves?: ShelfRow[];             // variant_shelf_stock rows (optional)
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

export type TalabatDeductionReason = "invalid_plan" | "insufficient_stock" | "inventory_inconsistent";

export type TalabatDeductionPlan =
  | { status: "ready"; deductions: DeductionTarget[]; resolution: Record<string, unknown> }
  | { status: "manual_review"; reason: TalabatDeductionReason; resolution: Record<string, unknown> };

/** Strict positive integer, else null. NEVER floors/coerces a bad value. */
function strictPositiveInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) return null;
  return v;
}
/** Strict non-negative integer, else null (invalid stock/shelf value). */
function strictNonNegInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return null;
  return v;
}
const keyOf = (pid: string, vsku: string | null): string => `${pid}||${vsku ?? ""}`;

/** inventory.stock_quantity rollup = SUM of the product's variant stock. */
export function sumVariantStock(variantStocks: Array<{ stock_quantity: number | null | undefined }>): number {
  return (variantStocks ?? []).reduce((s, v) => s + Math.max(0, Number(v.stock_quantity) || 0), 0);
}

/** Spread a deduction across shelves, biggest-first, never below zero. */
export function spreadAcrossShelves(shelves: ShelfRow[], qty: number): ShelfDeduction[] {
  const out: ShelfDeduction[] = [];
  let remaining = Math.max(0, Number(qty) || 0);
  for (const r of [...shelves].sort((a, b) => (Number(b.quantity) || 0) - (Number(a.quantity) || 0))) {
    if (remaining <= 0) break;
    const have = Math.max(0, Number(r.quantity) || 0);
    if (!have) continue;
    const take = Math.min(have, remaining);
    out.push({ location: r.location, deduct: take });
    remaining -= take;
  }
  return out;
}

const review = (reason: TalabatDeductionReason, detail: Record<string, unknown>): TalabatDeductionPlan =>
  ({ status: "manual_review", reason, resolution: { reason, ...detail } });

/**
 * Build an all-or-nothing deduction plan. Duplicate targets are aggregated FIRST
 * (so two lines for the same variant sum before the stock check). Every target
 * is then verified; any malformed quantity/empty plan (invalid_plan), missing/
 * mismatched/duplicate/negative snapshot (inventory_inconsistent), or shortfall
 * (insufficient_stock) makes the whole order manual_review — nothing deducted.
 */
export function buildTalabatDeductionPlan(targets: TargetInput[], stock: StockSnapshot[]): TalabatDeductionPlan {
  if (!Array.isArray(targets) || targets.length === 0) return review("invalid_plan", { detail: "empty_targets" });

  // Layer-2 defensive aggregation: duplicate (product, variant) targets summed.
  const agg = new Map<string, { masterProductId: string; masterVariantSku: string | null; quantity: number; lineKeys: string[] }>();
  for (const t of targets) {
    const q = strictPositiveInt(t.quantity);
    if (q === null) return review("invalid_plan", { detail: "non_positive_quantity" });
    const k = keyOf(t.masterProductId, t.masterVariantSku);
    const cur = agg.get(k) ?? { masterProductId: t.masterProductId, masterVariantSku: t.masterVariantSku, quantity: 0, lineKeys: [] };
    cur.quantity += q;
    if (t.lineKeys) cur.lineKeys.push(...t.lineKeys);
    agg.set(k, cur);
  }

  // Index snapshots — a DUPLICATE snapshot for one target is an inconsistency
  // (never let the last row silently win).
  const byKey = new Map<string, StockSnapshot>();
  const dupSnapshot = new Set<string>();
  for (const s of stock) {
    const k = s.kind === "variant" ? keyOf(s.masterProductId, s.masterVariantSku) : keyOf(s.masterProductId, null);
    if (byKey.has(k)) dupSnapshot.add(k);
    byKey.set(k, s);
  }

  const deductions: DeductionTarget[] = [];

  for (const t of agg.values()) {
    const k = keyOf(t.masterProductId, t.masterVariantSku);
    if (dupSnapshot.has(k)) return review("inventory_inconsistent", { failed: k, detail: "duplicate_stock_snapshot" });

    const snap = byKey.get(k);
    if (!snap) return review("inventory_inconsistent", { failed: k, detail: "no_stock_snapshot" });
    if (t.masterVariantSku !== null && snap.kind !== "variant") return review("inventory_inconsistent", { failed: k, detail: "expected_variant_stock" });
    if (t.masterVariantSku === null && snap.kind !== "product") return review("inventory_inconsistent", { failed: k, detail: "expected_product_stock" });

    const rawAvail = snap.kind === "variant" ? snap.variantStock : snap.inventoryStock;
    const available = strictNonNegInt(rawAvail);
    if (available === null) return review("inventory_inconsistent", { failed: k, detail: "invalid_stock_value" });

    if (snap.shelves && snap.shelves.length > 0) {
      let shelfSum = 0;
      for (const r of snap.shelves) {
        const q = strictNonNegInt(r.quantity);
        if (q === null) return review("inventory_inconsistent", { failed: k, detail: "invalid_shelf_value" });
        shelfSum += q;
      }
      if (shelfSum !== available) return review("inventory_inconsistent", { failed: k, detail: "variant_shelf_mismatch" });
    }

    if (t.quantity > available) return review("insufficient_stock", { failed: k, need: t.quantity, have: available });

    deductions.push({
      masterProductId: t.masterProductId,
      masterVariantSku: t.masterVariantSku,
      quantity: t.quantity,
      shelfPlan: snap.shelves && snap.shelves.length > 0 ? spreadAcrossShelves(snap.shelves, t.quantity) : [],
      lineKeys: t.lineKeys,
    });
  }

  return { status: "ready", deductions, resolution: { deductions } };
}

// ---- Resolution whitelist + manual-review payload (safe) --------------------

const RESOLUTION_ALLOWED = ["lines", "targets", "lineKeys", "reason", "reasons", "via", "method", "deductions"] as const;

/**
 * Keep ONLY known-safe keys from a resolution object — never raw payloads,
 * customer/phone/address, tokens, headers, or DB errors, even if a caller
 * mistakenly included them.
 */
export function sanitizeResolution(input: unknown): Record<string, unknown> {
  const src = (input && typeof input === "object") ? (input as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const k of RESOLUTION_ALLOWED) if (k in src && src[k] !== undefined) out[k] = src[k];
  return out;
}

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
