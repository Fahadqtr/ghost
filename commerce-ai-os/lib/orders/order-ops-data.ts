import "server-only";
// Read-only Order Operations DATA LAYER (Phase 2B.2).
//
// A SERVER-ONLY, dependency-injected wrapper that reads the ALREADY-CLASSIFIED
// columns of talabat_orders and shopify_synced_orders, projects ONLY whitelisted,
// PII-safe fields, and hands them to the pure Phase 2B.1 compute to produce a
// unified read model. It creates no DB client, performs no write/RPC/external
// call, and never surfaces a raw database error (no message/details/hint/code/
// stack/table/column). A read failure of one source never blocks the other; a
// partial result is explicitly marked so it can't be mistaken for a full total.

// Phase 2B.1 is referenced by a relative import. TYPES are imported statically
// (erased at runtime → node:test can load this file); the pure FUNCTIONS are
// injectable and, when not injected, are loaded lazily from the SAME relative
// module. Tests inject the real 2B.1 functions so rows are always produced
// through buildOrderOpsRows.
import type {
  OrderOpsInput,
  OrderOpsRow,
  OrderOpsSummary,
  ShopifyLedgerInput,
  ShopifyLedgerState,
  TalabatOrderInput,
} from "./order-ops-compute";

export interface OrderOpsCompute {
  buildOrderOpsRows(input: OrderOpsInput): OrderOpsRow[];
  summarizeOrderOps(rows: OrderOpsRow[]): OrderOpsSummary;
  classifyShopifyLedgerState(
    rows: ShopifyLedgerInput[] | null | undefined,
    evidence?: { reasonCode?: string | null },
  ): ShopifyLedgerState;
}

/** Lazily bind the real Phase 2B.1 compute from the relative module. */
async function defaultCompute(): Promise<OrderOpsCompute> {
  const m = await import("./order-ops-compute");
  return {
    buildOrderOpsRows: m.buildOrderOpsRows,
    summarizeOrderOps: m.summarizeOrderOps,
    classifyShopifyLedgerState: m.classifyShopifyLedgerState,
  };
}

// ── Injected read client (no Supabase client is created here) ────────────────

export interface OrderOpsQuery {
  table: "talabat_orders" | "shopify_synced_orders";
  columns: string; // explicit whitelist column list
  orderBy: { column: string; ascending: boolean }[];
  limit: number; // already limit + 1 (to detect hasMore)
}

/** A generic read result. A read is SUCCESSFUL only when the whole result is a
 *  plain object with `error === null` and `Array.isArray(data) === true`; the
 *  error's contents are NEVER read or surfaced. */
export interface OrderOpsQueryResult {
  data: unknown[] | null;
  error: unknown | null;
}

export interface OrderOpsReadClient {
  query(q: OrderOpsQuery): Promise<OrderOpsQueryResult>;
}

// ── Options + result contract ────────────────────────────────────────────────

export interface OrderOpsLoadOptions {
  /** Per-source row limit. Default 100, min 1, max 200; invalid values → 100. */
  limit?: number;
  /** Inject the Phase 2B.1 compute (tests / custom wiring). Defaults to the real module. */
  compute?: OrderOpsCompute;
}

export type OrderOpsReadStatus = "ok" | "error";
export type OrderOpsErrorCode = "talabat_read_failed" | "shopify_read_failed";

export interface OrderOpsSourceReadState {
  status: OrderOpsReadStatus;
  returned: number; // unified rows produced from this source (after the page limit)
  hasMore: boolean; // more valid page rows existed than the limit (never a full-table count)
  errorCode: OrderOpsErrorCode | null;
}

export interface ShopifyReadState extends OrderOpsSourceReadState {
  ledger: "empty" | "populated" | "unavailable";
  ledgerReasonCode: "no_synced_orders" | null; // preserved from Phase 2B.1; null when populated/unavailable
}

export interface OrderOpsDataResult {
  rows: OrderOpsRow[];
  summary: OrderOpsSummary;
  complete: boolean; // true only when BOTH sources read successfully
  scope: "complete" | "partial";
  sources: {
    talabat: OrderOpsSourceReadState;
    shopify: ShopifyReadState;
  };
}

// ── Explicit column whitelists (no raw/items/customer/phone/email/address) ───

// `talabat_orders` has no `created_at` column; its creation timestamp is
// `received_at`. We alias it to `created_at` at the PostgREST layer so the row
// arrives already keyed as `created_at` — the projector, TalabatOrderInput, and
// the whole downstream contract stay unchanged, and `received_at` is never
// returned as a separate field.
const TALABAT_COLUMNS = "id, order_code, event, processing_status, processed_at, created_at:received_at, resolution";
const SHOPIFY_COLUMNS =
  "order_id, order_name, channel, payment_gateway_names, deducted, processing_status, processed_at, synced_at, deduction_result";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MIN_LIMIT = 1;

// ── Small safe helpers ───────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** Keep a string value or null — never coerces non-strings. */
function stringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
/** Keep a number value or null — never coerces non-numbers. */
function numberOrNull(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
/** Normalize a requested limit: default 100, clamp [1,200]; invalid → default. */
function normalizeLimit(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < MIN_LIMIT) return DEFAULT_LIMIT;
  return Math.min(v, MAX_LIMIT);
}

// ── Explicit row projectors (new object, whitelisted keys only, no spread) ───

function projectTalabatRow(row: Record<string, unknown>): TalabatOrderInput {
  // id is passed THROUGH untouched (never String()-coerced) — Phase 2B.1 validates
  // it and marks malformed ids safely. resolution is passed for reason
  // classification only; Phase 2B.1 never emits it.
  return {
    id: row.id,
    order_code: stringOrNull(row.order_code),
    event: stringOrNull(row.event),
    processing_status: stringOrNull(row.processing_status),
    processed_at: stringOrNull(row.processed_at),
    created_at: stringOrNull(row.created_at),
    resolution: row.resolution,
    // NOTE: no refunded / evidence — the current schema has no trusted column for
    // either, so they are never fabricated here.
  };
}

function projectShopifyRow(row: Record<string, unknown>): ShopifyLedgerInput {
  // payment_gateway_names + deduction_result are passed for channel/status
  // classification only; Phase 2B.1 never emits them.
  return {
    order_id: row.order_id,
    order_name: stringOrNull(row.order_name),
    channel: stringOrNull(row.channel),
    payment_gateway_names: row.payment_gateway_names,
    deducted: numberOrNull(row.deducted),
    processing_status: stringOrNull(row.processing_status),
    processed_at: stringOrNull(row.processed_at),
    synced_at: stringOrNull(row.synced_at),
    deduction_result: row.deduction_result,
  };
}

// ── Safe query runner (classifies every failure to a stable code) ────────────

async function runQuery(client: OrderOpsReadClient, q: OrderOpsQuery): Promise<{ ok: boolean; rows: unknown[] }> {
  try {
    const res: unknown = await client.query(q);
    // STRICT success shape: a plain-object result with error === null AND a real
    // array in data. Anything else (null/undefined/non-object result, a truthy
    // error, or data that is null/object/string) is a classified source failure —
    // never a false "empty" read. Only data: [] is a successful empty read.
    if (isPlainObject(res) && res.error === null && Array.isArray(res.data)) {
      return { ok: true, rows: res.data };
    }
    return { ok: false, rows: [] };
  } catch {
    return { ok: false, rows: [] }; // thrown exception → failed; never re-surfaced
  }
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Load a unified, PII-safe operations read model. Each source is read
 * independently and fails closed to a classified state; results always flow
 * through Phase 2B.1's buildOrderOpsRows / summarizeOrderOps.
 */
export async function loadOrderOpsData(
  client: OrderOpsReadClient,
  options?: OrderOpsLoadOptions,
): Promise<OrderOpsDataResult> {
  const compute = options?.compute ?? (await defaultCompute());
  const limit = normalizeLimit(options?.limit);

  // Talabat — received_at desc, then id desc (received_at is the real creation
  // timestamp column; it is aliased to created_at in the projection above). Filter
  // NON-plain-object rows BEFORE paginating, so junk rows never displace valid
  // rows inside the limit nor cause a false hasMore. hasMore is based on valid
  // PAGE rows, never a full-table count.
  const talabatResult = await runQuery(client, {
    table: "talabat_orders",
    columns: TALABAT_COLUMNS,
    orderBy: [{ column: "received_at", ascending: false }, { column: "id", ascending: false }],
    limit: limit + 1,
  });
  const talabatValid = talabatResult.rows.filter(isPlainObject);
  const talabatHasMore = talabatResult.ok && talabatValid.length > limit;
  const talabatInputs = talabatResult.ok ? talabatValid.slice(0, limit).map(projectTalabatRow) : [];

  // Shopify — synced_at desc, then order_id desc.
  const shopifyResult = await runQuery(client, {
    table: "shopify_synced_orders",
    columns: SHOPIFY_COLUMNS,
    orderBy: [{ column: "synced_at", ascending: false }, { column: "order_id", ascending: false }],
    limit: limit + 1,
  });
  const shopifyValid = shopifyResult.rows.filter(isPlainObject);
  const shopifyHasMore = shopifyResult.ok && shopifyValid.length > limit;
  const shopifyInputs = shopifyResult.ok ? shopifyValid.slice(0, limit).map(projectShopifyRow) : [];

  // Unified rows are the single source of truth for `returned` (so an injected
  // compute that drops a row is reflected accurately).
  const rows = compute.buildOrderOpsRows({ talabat: talabatInputs, shopify: shopifyInputs });
  const summary = compute.summarizeOrderOps(rows);
  const talabatReturned = rows.filter((r) => r.source === "talabat").length;
  const shopifyReturned = rows.filter((r) => r.source === "shopify").length;

  // Classify the Shopify ledger ONCE from the successful read; a failed/malformed
  // read is "unavailable" (never conflated with an empty ledger), reason null.
  const shopifyLedger = shopifyResult.ok ? compute.classifyShopifyLedgerState(shopifyInputs) : null;

  const talabatState: OrderOpsSourceReadState = {
    status: talabatResult.ok ? "ok" : "error",
    returned: talabatReturned,
    hasMore: talabatHasMore,
    errorCode: talabatResult.ok ? null : "talabat_read_failed",
  };
  const shopifyState: ShopifyReadState = {
    status: shopifyResult.ok ? "ok" : "error",
    returned: shopifyReturned,
    hasMore: shopifyHasMore,
    errorCode: shopifyResult.ok ? null : "shopify_read_failed",
    ledger: shopifyLedger ? shopifyLedger.state : "unavailable",
    ledgerReasonCode: shopifyLedger && shopifyLedger.reason === "no_synced_orders" ? "no_synced_orders" : null,
  };

  const complete = talabatState.status === "ok" && shopifyState.status === "ok";

  return {
    rows,
    summary,
    complete,
    scope: complete ? "complete" : "partial",
    sources: { talabat: talabatState, shopify: shopifyState },
  };
}
