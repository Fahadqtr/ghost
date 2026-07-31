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

/**
 * inventory.stock_quantity rollup = SUM of the product's variant stock. FAIL-
 * CLOSED: ANY malformed value — null, undefined, negative, fractional, NaN,
 * Infinity, numeric string, or any non-number — returns null instead of being
 * silently coerced to 0 (a NULL sibling stock means the rollup is untrustworthy,
 * not "zero"). The caller turns null into inventory_inconsistent. Overflow past
 * the safe-integer range also returns null.
 */
export function sumVariantStock(variantStocks: Array<{ stock_quantity: number | null | undefined }>): number | null {
  let sum = 0;
  for (const v of variantStocks ?? []) {
    const n = v?.stock_quantity;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return null; // null/undefined included
    sum += n;
    if (!Number.isSafeInteger(sum)) return null;
  }
  return sum;
}

/**
 * Spread a deduction across shelves, biggest-first, never below zero. FAIL-CLOSED:
 * a malformed quantity or any malformed shelf quantity (negative, fractional,
 * NaN, Infinity, numeric string, non-number) returns null rather than coercing to
 * 0. The caller turns null into inventory_inconsistent.
 */
export function spreadAcrossShelves(shelves: ShelfRow[], qty: number): ShelfDeduction[] | null {
  if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 0) return null;
  const rows = shelves ?? [];
  for (const r of rows) {
    if (typeof r.quantity !== "number" || !Number.isInteger(r.quantity) || r.quantity < 0) return null;
  }
  const out: ShelfDeduction[] = [];
  let remaining = qty;
  for (const r of [...rows].sort((a, b) => b.quantity - a.quantity)) {
    if (remaining <= 0) break;
    if (r.quantity === 0) continue;
    const take = Math.min(r.quantity, remaining);
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
    if (!Number.isSafeInteger(cur.quantity)) return review("invalid_plan", { detail: "quantity_overflow" });
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

    let shelfPlan: ShelfDeduction[] = [];
    if (snap.shelves && snap.shelves.length > 0) {
      const spread = spreadAcrossShelves(snap.shelves, t.quantity);
      if (spread === null) return review("inventory_inconsistent", { failed: k, detail: "shelf_spread_failed" });
      shelfPlan = spread;
    }

    deductions.push({
      masterProductId: t.masterProductId,
      masterVariantSku: t.masterVariantSku,
      quantity: t.quantity,
      shelfPlan,
      lineKeys: t.lineKeys,
    });
  }

  return { status: "ready", deductions, resolution: { deductions } };
}

// ---- Resolution whitelist + manual-review payload (safe) --------------------

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const stringKeys = (v: unknown): string[] => asArray(v).filter((x): x is string => typeof x === "string");

// Scalar type guards — a field declared scalar can NEVER hold a nested object /
// array / wrong-typed value (so `lineKey: { phone, token }` is dropped even
// though "lineKey" is an allowed key). `undefined` means "omit this field".
const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asStrOrNull = (v: unknown): string | null | undefined => (typeof v === "string" ? v : v === null ? null : undefined);
const asPosInt = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);
const put = (out: Record<string, unknown>, k: string, v: unknown): void => { if (v !== undefined) out[k] = v; };

/** A resolution line — every kept field is type-checked to a scalar/target. */
function sanitizeLine(l: unknown): Record<string, unknown> {
  const src = isObj(l) ? l : {};
  const out: Record<string, unknown> = {};
  put(out, "lineKey", asStr(src.lineKey));
  put(out, "status", asStr(src.status));
  put(out, "via", asStr(src.via));
  put(out, "reason", asStr(src.reason));
  put(out, "quantity", asPosInt(src.quantity));
  if (isObj(src.target)) {
    const t: Record<string, unknown> = {};
    put(t, "masterProductId", asStr(src.target.masterProductId));
    put(t, "masterVariantSku", asStrOrNull(src.target.masterVariantSku));
    out.target = t;
  }
  return out;
}

/** A resolution target — scalar ids/quantity + a string-only lineKeys array. */
function sanitizeTarget(t: unknown): Record<string, unknown> {
  const src = isObj(t) ? t : {};
  const out: Record<string, unknown> = {};
  put(out, "masterProductId", asStr(src.masterProductId));
  put(out, "masterVariantSku", asStrOrNull(src.masterVariantSku));
  put(out, "quantity", asPosInt(src.quantity));
  if ("lineKeys" in src) out.lineKeys = stringKeys(src.lineKeys);
  return out;
}

/** A resolution reason — scalar lineKey + reason only. */
function sanitizeReason(r: unknown): Record<string, unknown> {
  const src = isObj(r) ? r : {};
  const out: Record<string, unknown> = {};
  put(out, "lineKey", asStr(src.lineKey));
  put(out, "reason", asStr(src.reason));
  return out;
}

/**
 * DEEP, TYPE-AWARE whitelist of a resolution object — never raw payloads,
 * customer/phone/address, tokens, headers, cookies, authorization, or DB errors,
 * even when nested inside `lines`/`targets`/`reasons` OR hidden inside the VALUE
 * of an allowed scalar key (e.g. `lineKey: { token: "…" }`). Every scalar field
 * is type-checked; `lines`/`targets`/`reasons` are rebuilt element-by-element,
 * never copied through.
 */
export function sanitizeResolution(input: unknown): Record<string, unknown> {
  const src = isObj(input) ? input : {};
  const out: Record<string, unknown> = {};
  if ("lines" in src) out.lines = asArray(src.lines).map(sanitizeLine);
  if ("targets" in src) out.targets = asArray(src.targets).map(sanitizeTarget);
  if ("reasons" in src) out.reasons = asArray(src.reasons).map(sanitizeReason);
  if ("lineKeys" in src) out.lineKeys = stringKeys(src.lineKeys);
  for (const k of ["reason", "via", "method"] as const) put(out, k, asStr(src[k]));
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
