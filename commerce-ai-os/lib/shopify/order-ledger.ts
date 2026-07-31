// CLAIM-BEFORE-DEDUCT contract for "Shopify order → our inventory" deductions.
//
// Self-contained: every side effect (ledger / inventory writes, stock logging) and
// every pure planner is DEPENDENCY-INJECTED, and only TYPES are imported from
// siblings (erased at runtime). So node:test — run under --conditions=react-server
// — can drive this with fakes, and the app bundle wires the real Supabase ports.
//
// Why this exists (the security invariant it enforces):
//   Inventory is our source of truth that the nightly sync PUSHES to Shopify. A
//   store sale must lower OUR stock exactly once. The old flow deducted stock and
//   only THEN tried to record the order in the idempotency ledger — so a failed
//   (and unchecked) ledger write could leave stock deducted but the order
//   unrecorded, and the next sync would deduct it a SECOND time.
//
//   This module inverts the order: it CLAIMS every considered order in the ledger
//   FIRST (verified), then deducts inventory ONLY for the orders THIS run
//   atomically claimed. Postgres `INSERT ... ON CONFLICT (order_id) DO NOTHING
//   RETURNING` is atomic at the row level, so the RETURNING set is exactly the
//   rows this run inserted. Guarantees:
//     • inventory is never deducted for an order that is not already recorded;
//     • the same order can never be deducted twice — not after a partial failure
//       (recorded orders are skipped next run) and not by a concurrent run (only
//       the run that won the row-level claim deducts it);
//     • an unexpected DB error on the claim aborts BEFORE any deduction and is
//       surfaced (never hidden, never a false success).
//   The only residual failure mode is a crash mid-deduction leaving an order
//   recorded but UNDER-deducted; the nightly push self-corrects that. There is no
//   over-deduction path.

import type { CatalogRowLite, OrderForDeduction, OrderDeductionPlan } from "./order-deduct-compute";

export interface DbError {
  code?: string | null;
  message?: string | null;
}
export interface DbResult<T> {
  data: T | null;
  error: DbError | null;
}

export interface LedgerRowBase {
  order_id: string;
  order_name: string | null;
  deducted: number;
}
export interface LedgerRowRich extends LedgerRowBase {
  channel: string;
  payment_gateway_names: string[];
}

/**
 * True ONLY for a genuine "the channel columns are not migrated yet" error, so the
 * base-columns fallback is used for that case and nothing else. A permission /
 * connection / constraint / any other error must NOT be mistaken for a missing
 * column — those abort the claim so no unexpected error is ever swallowed.
 */
export function isMissingColumnError(err: DbError | null | undefined): boolean {
  if (!err) return false;
  const code = String(err.code ?? "");
  if (code === "42703" || code === "PGRST204") return true; // undefined_column / PostgREST schema-cache miss
  const msg = String(err.message ?? "").toLowerCase();
  const namesNewColumn = msg.includes("channel") || msg.includes("payment_gateway_names");
  const looksLikeColumnMiss = msg.includes("column") || msg.includes("schema cache");
  return namesNewColumn && looksLikeColumnMiss;
}

export interface ClaimDeductPorts {
  /**
   * Upsert ledger rows with ON CONFLICT (order_id) DO NOTHING, RETURNING the rows
   * actually inserted. `data` is that inserted set (empty array when every row was
   * a duplicate). `error` is set on any DB failure.
   */
  upsertLedger(rows: (LedgerRowRich | LedgerRowBase)[]): Promise<DbResult<{ order_id: string }[]>>;
  /** Read inventory rows for one product. */
  readInventory(productId: string): Promise<DbResult<{ id: string | number; stock_quantity: number | null }[]>>;
  /** Write one inventory row's new stock quantity. */
  writeInventory(rowKey: string | number, stock: number): Promise<{ error: DbError | null }>;
  /** Best-effort: reflect the run's deducted count on the won ledger rows (telemetry only). */
  setLedgerDeducted(orderIds: string[], deducted: number): Promise<void>;
  /** Best-effort stock-transition log/task hook. */
  logStock(args: { productId: string; before: number; after: number }): Promise<void>;
}

export interface ClaimDeductPlanners {
  plan(orders: OrderForDeduction[], catalog: CatalogRowLite[], alreadySynced: Set<string>): OrderDeductionPlan;
  spread(rows: { rowKey: string | number; stock: number }[], qty: number): { rowKey: string | number; stock: number }[];
  classifyChannel(paymentGatewayNames: string[] | null | undefined): string;
}

export type ClaimDeductResult =
  | { ok: true; ordersProcessed: number; deducted: number; wonCount: number; baseline: boolean; note?: string }
  | { ok: false; ordersProcessed: 0; deducted: 0; note: string };

/**
 * Record considered orders (claim), then deduct inventory ONLY for the orders this
 * run won. See the file header for the full invariant. Never throws for a DB error
 * on the claim — it returns { ok:false } so the caller surfaces a skip note and
 * NOTHING is deducted. Individual inventory-write failures are tolerated (the order
 * is already recorded, so it can never be re-deducted); they just under-deduct.
 */
export async function claimAndDeduct(
  orders: OrderForDeduction[],
  catalog: CatalogRowLite[],
  alreadySynced: Set<string>,
  baseline: boolean,
  nameOf: Map<string, string>,
  ports: ClaimDeductPorts,
  planners: ClaimDeductPlanners,
): Promise<ClaimDeductResult> {
  const plan = planners.plan(orders, catalog, alreadySynced);
  if (!plan.considered.length) return { ok: true, ordersProcessed: 0, deducted: 0, wonCount: 0, baseline };

  const baseRows: LedgerRowBase[] = plan.considered.map((c) => ({
    order_id: c.id,
    order_name: c.name ?? nameOf.get(c.id) ?? null,
    deducted: 0, // filled in after deduction; idempotency never depends on it
  }));
  const richRows: LedgerRowRich[] = plan.considered.map((c, i) => ({
    ...baseRows[i],
    channel: planners.classifyChannel(c.paymentGatewayNames),
    payment_gateway_names: c.paymentGatewayNames,
  }));

  // 1) CLAIM. Try the rich write (channel columns); fall back to base columns ONLY
  //    for a genuine missing-migration-column error. Any other error aborts the
  //    whole step BEFORE deducting anything — a store sale is never subtracted from
  //    our stock unless its order is first durably recorded.
  let res = await ports.upsertLedger(richRows);
  if (res.error && isMissingColumnError(res.error)) {
    res = await ports.upsertLedger(baseRows);
  }
  if (res.error) {
    return { ok: false, ordersProcessed: 0, deducted: 0, note: "تخطى خصم الطلبات — تعذّر تسجيل الطلبات في السجل." };
  }

  // Orders THIS run atomically claimed (the RETURNING set). When the ledger returns
  // it (normal path) we deduct ONLY those. If the representation is unavailable we
  // degrade to the considered set — still claim-first, so a retry never re-deducts.
  const wonIds = Array.isArray(res.data) ? res.data.map((r) => r.order_id) : plan.considered.map((c) => c.id);
  const wonSet = new Set<string>(wonIds);

  // 2) Baseline first run: existing orders are now recorded; deduct nothing.
  if (baseline) {
    return {
      ok: true,
      ordersProcessed: plan.considered.length,
      deducted: 0,
      wonCount: wonSet.size,
      baseline: true,
      note: "أول تشغيل — سجّل الطلبات الحالية كخط أساس بدون خصم.",
    };
  }

  // 3) DEDUCT only the won orders. Re-plan on the won subset with the SAME pure
  //    matching/quantity logic — channel attribution never influences quantities.
  const wonOrders = orders.filter((o) => wonSet.has(o.id));
  const wonPlan = planners.plan(wonOrders, catalog, new Set<string>());
  let deducted = 0;
  for (const d of wonPlan.deductions) {
    const inv = await ports.readInventory(d.product_id);
    if (inv.error) continue; // safe: the order is already recorded → never re-deducted
    const rowStocks = ((inv.data ?? []) as { id: string | number; stock_quantity: number | null }[])
      .map((r) => ({ rowKey: r.id, stock: Number(r.stock_quantity) || 0 }));
    const updates = planners.spread(rowStocks, d.qty);
    let applied = 0; // what actually landed (clamped + write-checked)
    for (const u of updates) {
      const prev = rowStocks.find((r) => r.rowKey === u.rowKey)?.stock ?? 0;
      const { error } = await ports.writeInventory(u.rowKey, u.stock);
      if (!error) {
        deducted++;
        applied += prev - u.stock;
      }
    }
    // A store sale that empties the product opens the "mark unavailable" task.
    if (applied > 0) {
      const beforeTotal = rowStocks.reduce((s, r) => s + r.stock, 0);
      await ports.logStock({ productId: d.product_id, before: beforeTotal, after: beforeTotal - applied });
    }
  }

  // 4) Telemetry only: record the run's deducted count on the won rows. Its failure
  //    cannot affect idempotency (the rows already exist), so it is best-effort.
  if (deducted > 0) await ports.setLedgerDeducted([...wonSet], deducted);

  return { ok: true, ordersProcessed: plan.considered.length, deducted, wonCount: wonSet.size, baseline: false };
}
