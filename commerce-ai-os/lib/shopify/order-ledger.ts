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
//   the stock deduction as two separate REST calls is not safe, so the claim +
//   deduction + ledger completion for an order happen inside ONE Postgres
//   transaction (the process_shopify_order_deduction RPC). This module:
//     • computes each order's per-product plan with the SAME pure matching logic;
//     • is ALL-OR-NOTHING per order — an order with ANY unmatched positive-qty
//       line, or truncated line-item data, is NOT sent to the RPC and NOT recorded
//       (never deduct a matched subset of an incomplete order);
//     • calls the RPC once per order (Shopify Order GID is the idempotency key);
//     • FAILS CLOSED — it deducts nothing on its own and trusts ONLY an explicit
//       RPC success; a null/empty/unknown result, a DB error, or a missing
//       migration all mean "nothing deducted for this order".
//   It reports `complete`: the run is complete ONLY when every considered order
//   was fully settled. When !complete the caller MUST NOT push stock to Shopify
//   (a partial view would re-raise sold-out stock). There is NO TypeScript
//   inventory write on this path.

import type { CatalogRowLite, OrderForDeduction, DeductionTarget } from "./order-deduct-compute";

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
  // INV.5 grain-aware: variantId=null → simple product; set → a specific variant.
  p_deductions: { productId: string; variantId: string | null; quantity: number }[];
  p_baseline: boolean;
}

/** Authoritative before/after per affected grain (from the canonical sale RPC). */
export interface SettledProduct { productId: string; before: number; after: number }
export interface SettledVariant { productId: string; variantId: string; variantSku: string | null; before: number; after: number }

/**
 * True when the RPC / its migration is not present yet, so the whole step can skip
 * safely with a "migration required" reason instead of being mistaken for a normal
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
  /** Best-effort authoritative transition hook (does NOT write inventory). Fired
   *  once per settled order with every affected product + variant grain. */
  logTransitions(args: { products: SettledProduct[]; variants: SettledVariant[] }): Promise<void>;
}

export interface ClaimDeductPlanners {
  plan(
    orders: OrderForDeduction[],
    catalog: CatalogRowLite[],
    alreadySynced: Set<string>,
  ): {
    considered: { id: string }[];
    deductions: DeductionTarget[];
    unmatched: { title: string; qty: number }[];
  };
  classifyChannel(paymentGatewayNames: string[] | null | undefined): string;
}

export type BlockedReason =
  | "orders_truncated"
  | "line_items_truncated"
  | "unmatched_order"
  | "migration_required"
  | "db_error"
  | "unknown_response"
  | "insufficient_stock"
  | "inventory_inconsistent"
  | "invalid_plan"
  | "parent_has_shelf_rows";

/** RPC classified sale-failure reasons → a BlockedReason (fail closed, retryable). */
const SALE_FAILURE_REASONS = new Set<BlockedReason>([
  "insufficient_stock", "inventory_inconsistent", "invalid_plan", "parent_has_shelf_rows",
]);

export interface ClaimDeductResult {
  complete: boolean; // when false the caller MUST NOT push stock to Shopify
  processed: number; // orders confirmed recorded (processed | already | baseline)
  deducted: number; // inventory rows actually deducted (committed by the RPC)
  skipped: number; // orders safely skipped (not recorded, retried next run)
  baseline: boolean;
  blockedReason?: BlockedReason;
  note?: string;
}

const BASELINE_NOTE = "أول تشغيل — سجّل الطلبات الحالية كخط أساس بدون خصم.";

type Interpreted =
  | { kind: "processed"; deducted: number; products: SettledProduct[]; variants: SettledVariant[] }
  | { kind: "recorded" } // already_processed | baseline_recorded — recorded, nothing deducted here
  | { kind: "skip"; reason: BlockedReason } // FAIL CLOSED → deduct nothing
  | { kind: "migration" };

/** Map an RPC result to an outcome. Anything not an explicit success is a safe skip. */
function interpret(res: RpcResult): Interpreted {
  if (res.error) return isMissingDeductionMigration(res.error) ? { kind: "migration" } : { kind: "skip", reason: "db_error" };
  const d = res.data;
  // FAIL CLOSED: null / non-object / array → we do NOT know a deduction happened,
  // so we deduct nothing (and never claim success) for this order.
  if (!d || typeof d !== "object" || Array.isArray(d)) return { kind: "skip", reason: "unknown_response" };
  const status = String((d as { status?: unknown }).status ?? "");
  if (status === "processed") {
    const products = (d as { products?: unknown }).products;
    const variants = (d as { variants?: unknown }).variants;
    return {
      kind: "processed",
      deducted: Number((d as { deductedUnits?: unknown }).deductedUnits) || 0,
      products: Array.isArray(products) ? (products as SettledProduct[]) : [],
      variants: Array.isArray(variants) ? (variants as SettledVariant[]) : [],
    };
  }
  if (status === "already_processed" || status === "baseline_recorded") return { kind: "recorded" };
  // A classified sale failure (status:'error', reason:…) → fail closed, retryable,
  // NOTHING recorded by the RPC. Surface the specific reason when it's a known one.
  if (status === "error") {
    const reason = String((d as { reason?: unknown }).reason ?? "");
    if (SALE_FAILURE_REASONS.has(reason as BlockedReason)) return { kind: "skip", reason: reason as BlockedReason };
  }
  return { kind: "skip", reason: "unknown_response" }; // any unknown status → fail closed
}

/** The Shopify stock push may proceed ONLY when the order step is fully complete. */
export function syncCanPush(step: { complete?: boolean } | null | undefined): boolean {
  return step?.complete === true;
}

/**
 * Record + deduct every considered order through the single-transaction RPC. See
 * the file header for the invariant. Never throws for a DB error. `ordersComplete`
 * is false when the upstream Shopify fetch was truncated (more orders than were
 * read) — that alone blocks the push.
 */
export async function claimAndDeduct(
  orders: OrderForDeduction[],
  catalog: CatalogRowLite[],
  alreadySynced: Set<string>,
  baseline: boolean,
  nameOf: Map<string, string>,
  ports: ClaimDeductPorts,
  planners: ClaimDeductPlanners,
  ordersComplete: boolean = true,
): Promise<ClaimDeductResult> {
  let complete = ordersComplete;
  let blockedReason: BlockedReason | undefined = ordersComplete ? undefined : "orders_truncated";
  let processed = 0;
  let deducted = 0;
  let skipped = 0;

  const block = (reason: BlockedReason) => {
    complete = false;
    blockedReason ??= reason;
  };

  const plan = planners.plan(orders, catalog, alreadySynced);
  const consideredIds = new Set(plan.considered.map((c) => c.id));

  for (const o of orders) {
    if (!consideredIds.has(o.id)) continue;

    // Truncated line-item data → we don't know the full order; never process it.
    if (o.itemsTruncated) {
      block("line_items_truncated");
      skipped++;
      continue;
    }

    // Per-order plan with the SAME pure matching/quantity logic. The RPC only
    // spreads/clamps these already-decided quantities — it never re-matches.
    const per = planners.plan([o], catalog, new Set<string>());

    // ALL-OR-NOTHING: any unmatched positive-qty line blocks the whole order — no
    // RPC call, no record, no partial deduction of the matched subset.
    if (per.unmatched.length > 0) {
      block("unmatched_order");
      skipped++;
      continue;
    }

    const gateways = Array.isArray(o.paymentGatewayNames) ? o.paymentGatewayNames : [];
    const res = await ports.callDeduction({
      p_order_id: o.id,
      p_order_name: o.name ?? nameOf.get(o.id) ?? null,
      p_channel: planners.classifyChannel(gateways),
      p_payment_gateway_names: gateways,
      p_deductions: per.deductions.map((d) => ({ productId: d.productId, variantId: d.variantId, quantity: d.qty })),
      p_baseline: baseline,
    });

    const outcome = interpret(res);
    if (outcome.kind === "migration") {
      // The whole step needs the migration — stop, block the push, keep truthful
      // counts for anything the RPC already committed before this call.
      return { complete: false, processed, deducted, skipped, baseline, blockedReason: "migration_required" };
    }
    if (outcome.kind === "skip") {
      block(outcome.reason);
      skipped++;
      continue;
    }
    processed++;
    if (outcome.kind === "processed") {
      deducted += outcome.deducted;
      // Best-effort authoritative zero-crossing transitions (product + variant);
      // reads totals / opens tasks — never writes inventory.
      await ports.logTransitions({ products: outcome.products, variants: outcome.variants });
    }
  }

  const note = baseline && complete ? BASELINE_NOTE : undefined;
  return { complete, processed, deducted, skipped, baseline, ...(blockedReason ? { blockedReason } : {}), ...(note ? { note } : {}) };
}
