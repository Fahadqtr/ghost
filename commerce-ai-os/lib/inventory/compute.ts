// Inventory quantity arithmetic — pure, DB-free core.
// INV.3A establishes the canonical compute layer for numeric stock operations.
// It performs NO Supabase/network I/O and knows nothing about availability or channel state.

/** Floor of the absolute numeric quantity; 0 when unusable (NaN/0/empty). */
export function normalizeQty(quantity: unknown): number {
  const q = Math.floor(Math.abs(Number(quantity)));
  return Number.isFinite(q) ? q : 0;
}

export interface ApplyPlan {
  after: number;
  soldAfter: number | null;
}

/** Legacy movement-compatible IN/OUT planner. */
export function planApply(args: {
  type: "in" | "out";
  qty: number;
  before: number;
  sold: number;
  reason?: string | null;
}): { error: string } | ApplyPlan {
  const { type, qty, before, sold } = args;
  const delta = type === "in" ? qty : -qty;
  const after = before + delta;
  if (after < 0) {
    return { error: `الكمية غير كافية: المتوفّر ${before}، وحاولت إخراج ${qty}.` };
  }
  const isSale = type === "out" && (args.reason ?? "").toLowerCase() === "sale";
  return { after, soldAfter: isSale ? sold + qty : null };
}

/** FAIL-CLOSED parent rollup for variant products. */
export function sumVariantStock(
  variantStocks: Array<{ stock_quantity: number | null | undefined }>,
): number | null {
  let sum = 0;
  for (const v of variantStocks ?? []) {
    const n = v?.stock_quantity;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return null;
    sum += n;
    if (!Number.isSafeInteger(sum)) return null;
  }
  return sum;
}

export interface ShelfRow { location: string; quantity: number }
export interface ShelfDeduction { location: string; deduct: number }

/** Strict biggest-first deduction spread; FAIL-CLOSED on malformed input. */
export function spreadAcrossShelves(
  shelves: ShelfRow[],
  qty: number,
): ShelfDeduction[] | null {
  if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 0) return null;
  const rows = shelves ?? [];
  for (const row of rows) {
    if (typeof row.quantity !== "number" || !Number.isInteger(row.quantity) || row.quantity < 0) return null;
  }
  const out: ShelfDeduction[] = [];
  let remaining = qty;
  for (const row of [...rows].sort((a, b) => b.quantity - a.quantity)) {
    if (remaining <= 0) break;
    if (row.quantity === 0) continue;
    const take = Math.min(row.quantity, remaining);
    out.push({ location: row.location, deduct: take });
    remaining -= take;
  }
  return out;
}

export type InventoryOperation =
  | { kind: "adjust"; delta: number }
  | { kind: "sell"; quantity: number }
  | { kind: "setAbsolute"; quantity: number }
  | { kind: "setVariantAbsolute"; quantity: number }
  | { kind: "receive"; quantity: number };

export type InventoryPlanError =
  | "invalid_stock"
  | "invalid_quantity"
  | "insufficient_stock"
  | "overflow";

export type InventoryOperationPlan =
  | { status: "ready"; before: number; after: number; delta: number; soldAfter: number | null }
  | { status: "error"; error: InventoryPlanError };

function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** Strict generic planner for the future Inventory Engine facade. */
export function planInventoryOperation(args: {
  before: number;
  sold: number;
  operation: InventoryOperation;
}): InventoryOperationPlan {
  const { before, sold, operation } = args;
  if (!isNonNegativeSafeInt(before) || !isNonNegativeSafeInt(sold)) {
    return { status: "error", error: "invalid_stock" };
  }

  let after: number;
  let delta: number;
  let soldAfter: number | null = null;

  switch (operation.kind) {
    case "adjust":
      if (!isSafeInt(operation.delta)) return { status: "error", error: "invalid_quantity" };
      delta = operation.delta;
      after = before + delta;
      break;
    case "sell":
      if (!isNonNegativeSafeInt(operation.quantity)) return { status: "error", error: "invalid_quantity" };
      delta = -operation.quantity;
      after = before + delta;
      soldAfter = sold + operation.quantity;
      break;
    case "receive":
      if (!isNonNegativeSafeInt(operation.quantity)) return { status: "error", error: "invalid_quantity" };
      delta = operation.quantity;
      after = before + delta;
      break;
    case "setAbsolute":
    case "setVariantAbsolute":
      if (!isNonNegativeSafeInt(operation.quantity)) return { status: "error", error: "invalid_quantity" };
      after = operation.quantity;
      delta = after - before;
      break;
  }

  if (after < 0) return { status: "error", error: "insufficient_stock" };
  if (!Number.isSafeInteger(after)) return { status: "error", error: "overflow" };
  if (soldAfter !== null && !Number.isSafeInteger(soldAfter)) return { status: "error", error: "overflow" };
  return { status: "ready", before, after, delta, soldAfter };
}
