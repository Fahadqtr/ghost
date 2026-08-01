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
 * Fail-closed validation: returns the matching canonical spec, or throws the
 * constant rejection. Any deviation in table, columns, order count/columns/
 * direction, extra ordering, or an out-of-range/non-safe-integer limit is denied.
 */
function validateQuery(q: OrderOpsQuery): CanonicalQuerySpec {
  if (q === null || typeof q !== "object") throw rejected();

  const spec = CANONICAL_SPECS.find((s) => s.table === q.table);
  if (!spec) throw rejected();
  if (q.columns !== spec.columns) throw rejected();

  if (!Array.isArray(q.orderBy) || q.orderBy.length !== spec.orderBy.length) throw rejected();
  for (let i = 0; i < spec.orderBy.length; i++) {
    const got = q.orderBy[i];
    const want = spec.orderBy[i];
    if (got === null || typeof got !== "object") throw rejected();
    if (got.column !== want.column || got.ascending !== want.ascending) throw rejected();
  }

  const limit = q.limit;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < MIN_LIMIT || limit > MAX_LIMIT) {
    throw rejected();
  }
  return spec;
}

/**
 * Build an OrderOpsReadClient backed by the injected Supabase-like client. The
 * validated query is executed as from → select → order → order → limit; the
 * result's data/error are forwarded verbatim. A rejected query or a thrown
 * builder both surface as an exception for Phase 2B.2 to classify as a read
 * failure — nothing here is logged or transformed.
 */
export function createSupabaseOrderOpsReadClient(client: SupabaseOrderOpsClient): OrderOpsReadClient {
  return {
    async query(q: OrderOpsQuery): Promise<OrderOpsQueryResult> {
      const spec = validateQuery(q); // throws `order_ops_query_rejected` BEFORE any client call
      const [first, second] = spec.orderBy;
      const result = await client
        .from(spec.table)
        .select(spec.columns)
        .order(first.column, { ascending: first.ascending })
        .order(second.column, { ascending: second.ascending })
        .limit(q.limit);
      return { data: result.data, error: result.error };
    },
  };
}
