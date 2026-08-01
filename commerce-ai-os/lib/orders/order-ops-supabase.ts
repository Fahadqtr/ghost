import "server-only";
// Supabase read ADAPTER for Order Operations (Phase 2B.3A).
//
// A SERVER-ONLY factory that turns an injected Supabase-like server client into a
// Phase 2B.2 OrderOpsReadClient. It creates no client, imports no createClient,
// reads no environment variables, and performs no write / RPC / external call.
// It NEVER trusts an OrderOpsQuery just because it is typed: every query must
// match one of the two canonical Phase 2B.2 contracts EXACTLY (table, columns,
// both order clauses + directions, and a limit in [2, 201]) BEFORE .from() is
// touched; otherwise it throws the constant `order_ops_query_rejected` (with no
// table/column/value in the message). Results are forwarded verbatim as
// { data, error } — never logged, stringified, or transformed — so Phase 2B.2
// remains the sole owner of strict result validation and safe classification.

import type { OrderOpsQuery, OrderOpsQueryResult, OrderOpsReadClient } from "./order-ops-data";

// ── Minimal Supabase-like surface (only what the read chain needs) ───────────

export interface SupabaseOrderOpsResult {
  data: unknown[] | null;
  error: unknown | null;
}
export interface SupabaseOrderOpsFilterBuilder extends PromiseLike<SupabaseOrderOpsResult> {
  order(column: string, options: { ascending: boolean }): SupabaseOrderOpsFilterBuilder;
  limit(count: number): SupabaseOrderOpsFilterBuilder;
}
export interface SupabaseOrderOpsQueryBuilder {
  select(columns: string): SupabaseOrderOpsFilterBuilder;
}
export interface SupabaseOrderOpsClient {
  from(table: string): SupabaseOrderOpsQueryBuilder;
}

// ── Canonical, literal allowlist (mirrors the Phase 2B.2 query contracts) ────

interface OrderSpec {
  column: string;
  ascending: boolean;
}
interface CanonicalQuerySpec {
  table: OrderOpsQuery["table"];
  columns: string;
  orderBy: readonly [OrderSpec, OrderSpec];
}

const TALABAT_COLUMNS = "id, order_code, event, processing_status, processed_at, created_at, resolution";
const SHOPIFY_COLUMNS =
  "order_id, order_name, channel, payment_gateway_names, deducted, processing_status, processed_at, synced_at, deduction_result";

const CANONICAL_SPECS: readonly CanonicalQuerySpec[] = [
  {
    table: "talabat_orders",
    columns: TALABAT_COLUMNS,
    orderBy: [
      { column: "created_at", ascending: false },
      { column: "id", ascending: false },
    ],
  },
  {
    table: "shopify_synced_orders",
    columns: SHOPIFY_COLUMNS,
    orderBy: [
      { column: "synced_at", ascending: false },
      { column: "order_id", ascending: false },
    ],
  },
];

// Phase 2B.2 sends a normalized limit + 1, i.e. [1+1 .. 200+1] = [2 .. 201].
const MIN_LIMIT = 2;
const MAX_LIMIT = 201;
const REJECTED = "order_ops_query_rejected";

/** A constant, detail-free rejection. Never includes table/column/value. */
function rejected(): Error {
  return new Error(REJECTED);
}

/**
 * An immutable, fully-captured execution plan. Nothing here is a reference back
 * into the (untrusted) query — every field is a snapshot taken exactly once
 * during validation, so execution can never observe a different value than the
 * one that was checked (no TOCTOU via a mutating getter / Proxy).
 */
interface ValidatedQueryPlan {
  table: OrderOpsQuery["table"];
  columns: string;
  orderBy: readonly [OrderSpec, OrderSpec];
  limit: number;
}

/**
 * Fail-closed validation. Reads EVERY untrusted field EXACTLY ONCE (inside a
 * try/catch, so a throwing getter/Proxy becomes the constant rejection), then
 * validates only the captured snapshot and returns a fresh immutable plan built
 * from canonical values + the single captured limit. After this returns, the
 * query object is never read again.
 */
function validateQuery(q: OrderOpsQuery): ValidatedQueryPlan {
  // 1) Capture — one read per untrusted field. Any throw → constant rejection.
  let table: unknown;
  let columns: unknown;
  let limit: unknown;
  let firstColumn: unknown;
  let firstAscending: unknown;
  let secondColumn: unknown;
  let secondAscending: unknown;
  try {
    if (q === null || typeof q !== "object") throw rejected();
    table = q.table;
    columns = q.columns;
    limit = q.limit;
    const orderBy: unknown = q.orderBy; // single read of the array reference
    if (!Array.isArray(orderBy) || orderBy.length !== 2) throw rejected();
    const first: unknown = orderBy[0];
    const second: unknown = orderBy[1];
    if (first === null || typeof first !== "object") throw rejected();
    if (second === null || typeof second !== "object") throw rejected();
    firstColumn = (first as { column?: unknown }).column;
    firstAscending = (first as { ascending?: unknown }).ascending;
    secondColumn = (second as { column?: unknown }).column;
    secondAscending = (second as { ascending?: unknown }).ascending;
  } catch {
    throw rejected(); // never leak the original getter/Proxy error text
  }

  // 2) Validate the captured snapshot ONLY (no further reads of q).
  const spec = CANONICAL_SPECS.find((s) => s.table === table);
  if (!spec) throw rejected();
  if (columns !== spec.columns) throw rejected();
  if (firstColumn !== spec.orderBy[0].column || firstAscending !== spec.orderBy[0].ascending) throw rejected();
  if (secondColumn !== spec.orderBy[1].column || secondAscending !== spec.orderBy[1].ascending) throw rejected();
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < MIN_LIMIT || limit > MAX_LIMIT) {
    throw rejected();
  }

  // 3) Build a fresh immutable plan (canonical strings + the ONE captured limit;
  //    order values are copied, never references into the query).
  return {
    table: spec.table,
    columns: spec.columns,
    orderBy: [
      { column: spec.orderBy[0].column, ascending: spec.orderBy[0].ascending },
      { column: spec.orderBy[1].column, ascending: spec.orderBy[1].ascending },
    ],
    limit,
  };
}

/**
 * Build an OrderOpsReadClient backed by the injected Supabase-like client. The
 * query is validated into an immutable plan and executed ONLY from that plan
 * (from → select → order → order → limit); the query object is never read again.
 * The result's data/error are forwarded verbatim. A rejected query or a thrown
 * builder both surface as an exception for Phase 2B.2 to classify as a read
 * failure — nothing here is logged or transformed.
 */
export function createSupabaseOrderOpsReadClient(client: SupabaseOrderOpsClient): OrderOpsReadClient {
  return {
    async query(q: OrderOpsQuery): Promise<OrderOpsQueryResult> {
      const plan = validateQuery(q); // throws `order_ops_query_rejected` BEFORE any client call
      const result = await client
        .from(plan.table)
        .select(plan.columns)
        .order(plan.orderBy[0].column, { ascending: plan.orderBy[0].ascending })
        .order(plan.orderBy[1].column, { ascending: plan.orderBy[1].ascending })
        .limit(plan.limit);
      return { data: result.data, error: result.error };
    },
  };
}
