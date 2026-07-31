// TRANSACTIONAL "Shopify order → our inventory" deduction contract.
//
// Self-contained: every side effect (the deduction RPC, stock-transition logging)
// and every pure planner is DEPENDENCY-INJECTED, and only TYPES are imported from
// siblings (erased at runtime). So node:test — run under --conditions=react-server
// — can drive this with fakes, and the app bundle wires the real Supabase ports.
//
// Why this exists (the security invariant it enforces):
//   Inventory is our source of truth that the nightly sync PUSHES to Shopify. A
//   store sale must lower OUR stock EXACTLY once. Doing the idempotency claim and
//   the stock deduction as two separate REST calls is not safe: a failure between
//   them can leave stock deducted-but-unrecorded (→ the next sync deducts again)
//   or recorded-but-under-deducted (→ the nightly push re-raises the sold stock).
//
//   So the actual claim + deduction + ledger completion happen inside ONE Postgres
//   transaction (the process_shopify_order_deduction RPC). This module only:
//     • computes each order's per-product plan with the SAME pure matching logic;
//     • calls the RPC once per order (Shopify Order GID is the idempotency key);
//     • FAILS CLOSED — it deducts nothing on its own and trusts ONLY an explicit
//       RPC success. A null/empty/unknown RPC result, a DB error, or a missing
//       migration all yield "nothing deducted for this order" (safe skip / retry).
//   There is NO TypeScript inventory write on this path.

import type { CatalogRowLite, OrderForDeduction } from "./order-deduct-compute";

export interface DbError {
  code?: string | null;
  message?: string | null;
}
export interface RpcResult {
  data: unknown;
  error: DbError | null;
}

export interface DeductionRpcArgs {
  p_order_id: string;
  p_order_name: string | null;
  p_channel: string;
  p_payment_gateway_names: string[];
  p_deductions: { product_id: string; quantity: number }[];
  p_baseline: boolean;
}

/**
 * True when the RPC / its migration is not present yet, so the whole step can skip
 * safely with a "migration required" note instead of being mistaken for a normal
 * failure. Covers: undefined_function (42883 / PostgREST PGRST202), a missing
 * relation the function depends on (42P01 / PGRST205), and a message naming the
 * function or one of the added ledger columns. A permission / connection /
 * constraint error is NOT a missing migration — those are ordinary safe skips.
 */
export function isMissingDeductionMigration(err: DbError | null | undefined): boolean {
  if (!err) return false;
  const code = String(err.code ?? "");
  if (code === "42883" || code === "PGRST202" || code === "42P01" || code === "PGRST205") return true;
  const msg = String(err.message ?? "").toLowerCase();
  const namesFn = msg.includes("process_shopify_order_deduction");
  const namesCol = msg.includes("processing_status") || msg.includes("deduction_result");
  const looksMissing = msg.includes("does not exist") || msg.includes("could not find") || msg.includes("schema cache");
  return (namesFn || namesCol) && looksMissing;
}

export interface ClaimDeductPorts {
  /** Call the single-transaction deduction RPC for one order. */
  callDeduction(args: DeductionRpcArgs): Promise<RpcResult>;
  /** Best-effort stock-transition log/task hook (does NOT write inventory). */
  logStock(args: { productId: string; before: number; after: number }): Promise<void>;
}

export interface ClaimDeductPlanners {
  plan(
    orders: OrderForDeduction[],
    catalog: CatalogRowLite[],
    alreadySynced: Set<string>,
  ): { considered: { id: string }[]; deductions: { product_id: string; qty: number }[] };
  classifyChannel(paymentGatewayNames: string[] | null | undefined): string;
}

export type ClaimDeductResult =
  | { ok: true; ordersProcessed: number; deducted: number; recorded: number; skipped: number; baseline: boolean; note?: string }
  | { ok: false; ordersProcessed: 0; deducted: 0; note: string };

const MIGRATION_NOTE = "تخطى خصم الطلبات — required migration: شغّل supabase/shopify_synced_orders_deduction.sql مرة واحدة.";
const SKIP_NOTE = "تخطى بعض الطلبات بأمان (خطأ قاعدة بيانات مؤقت) — سيُعاد المحاولة في التشغيل القادم.";
const BASELINE_NOTE = "أول تشغيل — سجّل الطلبات الحالية كخط أساس بدون خصم.";

type Interpreted =
  | { kind: "processed"; deducted: number; products: { product_id: string; before: number; after: number }[] }
  | { kind: "recorded" } // already_processed | baseline_recorded — recorded, nothing deducted here
  | { kind: "skip" } // FAIL CLOSED — null/empty/unknown/error → deduct nothing
  | { kind: "migration" };

/** Map an RPC result to an outcome. Anything not an explicit success is a safe skip. */
function interpret(res: RpcResult): Interpreted {
  if (res.error) return isMissingDeductionMigration(res.error) ? { kind: "migration" } : { kind: "skip" };
  const d = res.data;
  // FAIL CLOSED: no rows / null / non-object / array → we do NOT know a deduction
  // happened, so we deduct nothing (and never claim success) for this order.
  if (!d || typeof d !== "object" || Array.isArray(d)) return { kind: "skip" };
  const status = String((d as { status?: unknown }).status ?? "");
  if (status === "processed") {
    const products = (d as { products?: unknown }).products;
    return {
      kind: "processed",
      deducted: Number((d as { deducted?: unknown }).deducted) || 0,
      products: Array.isArray(products) ? (products as { product_id: string; before: number; after: number }[]) : [],
    };
  }
  if (status === "already_processed" || status === "baseline_recorded") return { kind: "recorded" };
  return { kind: "skip" }; // 'error' or any unknown status → fail closed
}

/**
 * Record + deduct every considered order through the single-transaction RPC. See
 * the file header for the invariant. Never throws for a DB error — a missing
 * migration returns { ok:false } with a migration note (nothing touched); any
 * other per-order error is a safe skip (that order is neither recorded nor
 * deducted, so the next run retries it cleanly).
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
  if (!plan.considered.length) return { ok: true, ordersProcessed: 0, deducted: 0, recorded: 0, skipped: 0, baseline };

  const consideredIds = new Set(plan.considered.map((c) => c.id));
  let deducted = 0;
  let recorded = 0;
  let skipped = 0;

  for (const o of orders) {
    if (!consideredIds.has(o.id)) continue;

    // Per-order plan with the SAME pure matching/quantity logic. The RPC only
    // spreads/clamps these already-decided quantities — it never re-matches.
    const per = planners.plan([o], catalog, new Set<string>());
    const gateways = Array.isArray(o.paymentGatewayNames) ? o.paymentGatewayNames : [];
    const res = await ports.callDeduction({
      p_order_id: o.id,
      p_order_name: o.name ?? nameOf.get(o.id) ?? null,
      p_channel: planners.classifyChannel(gateways),
      p_payment_gateway_names: gateways,
      p_deductions: per.deductions.map((d) => ({ product_id: d.product_id, quantity: d.qty })),
      p_baseline: baseline,
    });

    const outcome = interpret(res);
    if (outcome.kind === "migration") {
      // The whole step needs the migration — abort without claiming any success.
      return { ok: false, ordersProcessed: 0, deducted: 0, note: MIGRATION_NOTE };
    }
    if (outcome.kind === "skip") {
      skipped++; // fail closed: not recorded, not deducted → retried next run
      continue;
    }
    recorded++;
    if (outcome.kind === "processed") {
      deducted += outcome.deducted;
      // OOS "mark unavailable" tasks — reads totals, opens a task; no stock write.
      for (const p of outcome.products) {
        await ports.logStock({ productId: p.product_id, before: Number(p.before) || 0, after: Number(p.after) || 0 });
      }
    }
  }

  const note = baseline ? BASELINE_NOTE : skipped > 0 ? SKIP_NOTE : undefined;
  return { ok: true, ordersProcessed: recorded, deducted, recorded, skipped, baseline, ...(note ? { note } : {}) };
}
