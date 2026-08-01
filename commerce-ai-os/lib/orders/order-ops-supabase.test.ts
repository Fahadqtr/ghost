// Tests for the Supabase read adapter (Phase 2B.3A). Fake Supabase-like client only.
// Run: node --conditions=react-server --experimental-strip-types --test lib/orders/order-ops-supabase.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  createSupabaseOrderOpsReadClient,
  type SupabaseOrderOpsClient,
  type SupabaseOrderOpsResult,
} from "./order-ops-supabase.ts";
import { loadOrderOpsData, type OrderOpsQuery } from "./order-ops-data.ts";
import { buildOrderOpsRows, summarizeOrderOps, classifyShopifyLedgerState } from "./order-ops-compute.ts";

const REAL_COMPUTE = { buildOrderOpsRows, summarizeOrderOps, classifyShopifyLedgerState };

const TALABAT_COLUMNS = "id, order_code, event, processing_status, processed_at, created_at, resolution";
const SHOPIFY_COLUMNS =
  "order_id, order_name, channel, payment_gateway_names, deducted, processing_status, processed_at, synced_at, deduction_result";

const talabatQuery = (over: Partial<OrderOpsQuery> = {}): OrderOpsQuery => ({
  table: "talabat_orders",
  columns: TALABAT_COLUMNS,
  orderBy: [{ column: "created_at", ascending: false }, { column: "id", ascending: false }],
  limit: 101,
  ...over,
});
const shopifyQuery = (over: Partial<OrderOpsQuery> = {}): OrderOpsQuery => ({
  table: "shopify_synced_orders",
  columns: SHOPIFY_COLUMNS,
  orderBy: [{ column: "synced_at", ascending: false }, { column: "order_id", ascending: false }],
  limit: 101,
  ...over,
});

// ── Fake Supabase-like client (records calls; optional per-table result/throw) ─

interface TableCfg {
  result?: SupabaseOrderOpsResult;
  throwAt?: "from" | "select" | "order" | "limit";
}
function fakeSupabase(cfg: Record<string, TableCfg> = {}) {
  const calls = {
    from: [] as string[],
    select: [] as { table: string; columns: string }[],
    order: [] as { table: string; column: string; ascending: boolean }[],
    limit: [] as { table: string; count: number }[],
    mutated: [] as string[], // records any forbidden method access
  };
  const client: SupabaseOrderOpsClient = {
    from(table) {
      calls.from.push(table);
      const c = cfg[table] ?? {};
      if (c.throwAt === "from") throw new Error("builder boom SECRET");
      const fb = {
        order(column: string, options: { ascending: boolean }) {
          calls.order.push({ table, column, ascending: options.ascending });
          if (c.throwAt === "order") throw new Error("builder boom SECRET");
          return fb;
        },
        limit(count: number) {
          calls.limit.push({ table, count });
          if (c.throwAt === "limit") throw new Error("builder boom SECRET details code=42P01");
          return fb;
        },
        then<T>(onFulfilled?: (v: SupabaseOrderOpsResult) => T): Promise<T> {
          return Promise.resolve(c.result ?? { data: [], error: null }).then(onFulfilled as (v: SupabaseOrderOpsResult) => T);
        },
      };
      return {
        select(columns: string) {
          calls.select.push({ table, columns });
          if (c.throwAt === "select") throw new Error("builder boom SECRET");
          return fb;
        },
      };
    },
  };
  return { client, calls };
}

// ── Valid execution ──────────────────────────────────────────────────────────

test("valid Talabat query executes with exact table/columns/order/limit", async () => {
  const { client, calls } = fakeSupabase({ talabat_orders: { result: { data: [{ id: "t1" }], error: null } } });
  const adapter = createSupabaseOrderOpsReadClient(client);
  const res = await adapter.query(talabatQuery());
  assert.deepEqual(calls.from, ["talabat_orders"]);
  assert.deepEqual(calls.select, [{ table: "talabat_orders", columns: TALABAT_COLUMNS }]);
  assert.deepEqual(calls.order, [
    { table: "talabat_orders", column: "created_at", ascending: false },
    { table: "talabat_orders", column: "id", ascending: false },
  ]);
  assert.deepEqual(calls.limit, [{ table: "talabat_orders", count: 101 }]);
  assert.deepEqual(res, { data: [{ id: "t1" }], error: null });
});

test("valid Shopify query executes with exact table/columns/order/limit", async () => {
  const { client, calls } = fakeSupabase({ shopify_synced_orders: { result: { data: [], error: null } } });
  const adapter = createSupabaseOrderOpsReadClient(client);
  await adapter.query(shopifyQuery());
  assert.deepEqual(calls.from, ["shopify_synced_orders"]);
  assert.deepEqual(calls.select, [{ table: "shopify_synced_orders", columns: SHOPIFY_COLUMNS }]);
  assert.deepEqual(calls.order, [
    { table: "shopify_synced_orders", column: "synced_at", ascending: false },
    { table: "shopify_synced_orders", column: "order_id", ascending: false },
  ]);
  assert.deepEqual(calls.limit, [{ table: "shopify_synced_orders", count: 101 }]);
});

test("result data/error are forwarded verbatim (same references, no transform)", async () => {
  const data = [{ order_id: "s1" }];
  const error = { message: "SECRET", code: "42P01", details: "d", hint: "h" };
  const { client } = fakeSupabase({ shopify_synced_orders: { result: { data, error } } });
  const adapter = createSupabaseOrderOpsReadClient(client);
  const res = await adapter.query(shopifyQuery());
  assert.equal(res.data, data); // identity — not copied/stringified
  assert.equal(res.error, error);
  assert.deepEqual(Object.keys(res).sort(), ["data", "error"]); // no extra metadata
});

test("data:null is forwarded as-is (adapter does NOT treat it as success)", async () => {
  const { client } = fakeSupabase({ talabat_orders: { result: { data: null, error: null } } });
  const adapter = createSupabaseOrderOpsReadClient(client);
  const res = await adapter.query(talabatQuery());
  assert.equal(res.data, null); // forwarded; Phase 2B.2 decides this is a failure
});

// ── Fail-closed rejection (before .from()) ───────────────────────────────────

async function assertRejectedBeforeFrom(q: OrderOpsQuery): Promise<void> {
  const { client, calls } = fakeSupabase();
  const adapter = createSupabaseOrderOpsReadClient(client);
  await assert.rejects(
    adapter.query(q),
    (e: unknown) => e instanceof Error && e.message === "order_ops_query_rejected",
  );
  assert.equal(calls.from.length, 0, "must reject before calling from()");
}

test("wrong table rejected before from()", () => assertRejectedBeforeFrom(talabatQuery({ table: "inventory" as unknown as OrderOpsQuery["table"] })));
test("wrong Talabat columns rejected", () => assertRejectedBeforeFrom(talabatQuery({ columns: "id, raw" })));
test("wrong Shopify columns rejected", () => assertRejectedBeforeFrom(shopifyQuery({ columns: "order_id, customer" })));
test("wrong first order column rejected", () =>
  assertRejectedBeforeFrom(talabatQuery({ orderBy: [{ column: "id", ascending: false }, { column: "id", ascending: false }] })));
test("wrong second order column rejected", () =>
  assertRejectedBeforeFrom(talabatQuery({ orderBy: [{ column: "created_at", ascending: false }, { column: "order_code", ascending: false }] })));
test("ascending true rejected", () =>
  assertRejectedBeforeFrom(talabatQuery({ orderBy: [{ column: "created_at", ascending: true }, { column: "id", ascending: false }] })));
test("missing (single) order rejected", () =>
  assertRejectedBeforeFrom(talabatQuery({ orderBy: [{ column: "created_at", ascending: false }] })));
test("extra third order rejected", () =>
  assertRejectedBeforeFrom(
    talabatQuery({
      orderBy: [
        { column: "created_at", ascending: false },
        { column: "id", ascending: false },
        { column: "id", ascending: false },
      ],
    }),
  ));
test("limit below 2 rejected", () => assertRejectedBeforeFrom(talabatQuery({ limit: 1 })));
test("limit above 201 rejected", () => assertRejectedBeforeFrom(talabatQuery({ limit: 202 })));
test("fractional limit rejected", () => assertRejectedBeforeFrom(talabatQuery({ limit: 100.5 })));
test("NaN / Infinity / unsafe-integer limit rejected", async () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    await assertRejectedBeforeFrom(talabatQuery({ limit: bad }));
  }
});

test("rejection error is EXACTLY 'order_ops_query_rejected' with no table/column/value details", async () => {
  const { client } = fakeSupabase();
  const adapter = createSupabaseOrderOpsReadClient(client);
  try {
    await adapter.query(talabatQuery({ table: "secret_table" as unknown as OrderOpsQuery["table"], columns: "leaky_col", limit: 999 }));
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof Error);
    assert.equal(e.message, "order_ops_query_rejected");
    for (const leak of ["secret_table", "leaky_col", "999"]) assert.ok(!e.message.includes(leak), `leaked: ${leak}`);
  }
});

// ── Thrown builder propagates (adapter does not swallow it) ───────────────────

test("a thrown builder error propagates as an exception (for Phase 2B.2 to classify)", async () => {
  const { client } = fakeSupabase({ talabat_orders: { throwAt: "limit" } });
  const adapter = createSupabaseOrderOpsReadClient(client);
  await assert.rejects(adapter.query(talabatQuery())); // not caught/transformed here
});

// ── TOCTOU: untrusted fields read once; execution uses the validated plan ─────

test("alternating limit getter is read ONCE; executed limit is exactly the first (validated) value", async () => {
  const { client, calls } = fakeSupabase({ talabat_orders: { result: { data: [], error: null } } });
  const adapter = createSupabaseOrderOpsReadClient(client);
  let reads = 0;
  const q = {
    table: "talabat_orders",
    columns: TALABAT_COLUMNS,
    orderBy: [{ column: "created_at", ascending: false }, { column: "id", ascending: false }],
    get limit() {
      reads++;
      return reads === 1 ? 101 : 1_000_000;
    },
  } as unknown as OrderOpsQuery;
  await adapter.query(q);
  assert.equal(reads, 1);
  assert.deepEqual(calls.limit, [{ table: "talabat_orders", count: 101 }]);
});

test("alternating table getter is read ONCE; canonical table executed", async () => {
  const { client, calls } = fakeSupabase({ talabat_orders: { result: { data: [], error: null } } });
  const adapter = createSupabaseOrderOpsReadClient(client);
  let reads = 0;
  const q = {
    get table() {
      reads++;
      return reads === 1 ? "talabat_orders" : "shopify_synced_orders";
    },
    columns: TALABAT_COLUMNS,
    orderBy: [{ column: "created_at", ascending: false }, { column: "id", ascending: false }],
    limit: 101,
  } as unknown as OrderOpsQuery;
  await adapter.query(q);
  assert.equal(reads, 1);
  assert.deepEqual(calls.from, ["talabat_orders"]);
});

test("alternating columns getter is read ONCE; canonical columns executed", async () => {
  const { client, calls } = fakeSupabase({ talabat_orders: { result: { data: [], error: null } } });
  const adapter = createSupabaseOrderOpsReadClient(client);
  let reads = 0;
  const q = {
    table: "talabat_orders",
    get columns() {
      reads++;
      return reads === 1 ? TALABAT_COLUMNS : "id, raw, customer";
    },
    orderBy: [{ column: "created_at", ascending: false }, { column: "id", ascending: false }],
    limit: 101,
  } as unknown as OrderOpsQuery;
  await adapter.query(q);
  assert.equal(reads, 1);
  assert.deepEqual(calls.select, [{ table: "talabat_orders", columns: TALABAT_COLUMNS }]);
});

test("orderBy getter is read ONCE; copied validated ordering executed", async () => {
  const { client, calls } = fakeSupabase({ talabat_orders: { result: { data: [], error: null } } });
  const adapter = createSupabaseOrderOpsReadClient(client);
  let reads = 0;
  const good = [{ column: "created_at", ascending: false }, { column: "id", ascending: false }];
  const q = {
    table: "talabat_orders",
    columns: TALABAT_COLUMNS,
    get orderBy() {
      reads++;
      return reads === 1 ? good : [{ column: "id", ascending: true }, { column: "created_at", ascending: true }];
    },
    limit: 101,
  } as unknown as OrderOpsQuery;
  await adapter.query(q);
  assert.equal(reads, 1);
  assert.deepEqual(calls.order, [
    { table: "talabat_orders", column: "created_at", ascending: false },
    { table: "talabat_orders", column: "id", ascending: false },
  ]);
});

test("nested order column/ascending getters read ONCE; copied values executed", async () => {
  const { client, calls } = fakeSupabase({ talabat_orders: { result: { data: [], error: null } } });
  const adapter = createSupabaseOrderOpsReadClient(client);
  let colReads = 0;
  let ascReads = 0;
  const first = {
    get column() {
      colReads++;
      return "created_at";
    },
    get ascending() {
      ascReads++;
      return false;
    },
  };
  const q = {
    table: "talabat_orders",
    columns: TALABAT_COLUMNS,
    orderBy: [first, { column: "id", ascending: false }],
    limit: 101,
  } as unknown as OrderOpsQuery;
  await adapter.query(q);
  assert.equal(colReads, 1);
  assert.equal(ascReads, 1);
  assert.deepEqual(calls.order[0], { table: "talabat_orders", column: "created_at", ascending: false });
});

test("a getter that throws during validation → constant rejection, from() not called, no leak", async () => {
  const { client, calls } = fakeSupabase();
  const adapter = createSupabaseOrderOpsReadClient(client);
  const q = {
    get table(): string {
      throw new Error("GETTER BOOM SECRET");
    },
    columns: TALABAT_COLUMNS,
    orderBy: [{ column: "created_at", ascending: false }, { column: "id", ascending: false }],
    limit: 101,
  } as unknown as OrderOpsQuery;
  await assert.rejects(adapter.query(q), (e: unknown) => e instanceof Error && e.message === "order_ops_query_rejected" && !e.message.includes("BOOM"));
  assert.equal(calls.from.length, 0);
});

test("a Proxy that throws on any property access → constant rejection, from() not called", async () => {
  const { client, calls } = fakeSupabase();
  const adapter = createSupabaseOrderOpsReadClient(client);
  const q = new Proxy(
    {},
    {
      get() {
        throw new Error("PROXY SECRET");
      },
    },
  ) as unknown as OrderOpsQuery;
  await assert.rejects(adapter.query(q), (e: unknown) => e instanceof Error && e.message === "order_ops_query_rejected" && !e.message.includes("PROXY"));
  assert.equal(calls.from.length, 0);
});

// ── Integration with Phase 2B.2 (real loadOrderOpsData + real adapter) ───────

test("integration: both sources succeed → complete", async () => {
  const { client } = fakeSupabase({
    talabat_orders: { result: { data: [{ id: "gid://t/1", processing_status: "processed" }], error: null } },
    shopify_synced_orders: { result: { data: [{ order_id: "gid://s/1", deduction_result: { status: "processed" } }], error: null } },
  });
  const adapter = createSupabaseOrderOpsReadClient(client);
  const res = await loadOrderOpsData(adapter, { compute: REAL_COMPUTE });
  assert.equal(res.complete, true);
  assert.equal(res.scope, "complete");
  assert.equal(res.rows.length, 2);
});

test("integration: Shopify builder throws → partial + shopify_read_failed + ledger unavailable; no raw leak", async () => {
  const { client } = fakeSupabase({
    talabat_orders: { result: { data: [{ id: "t1", processing_status: "processed" }], error: null } },
    shopify_synced_orders: { throwAt: "limit" },
  });
  const adapter = createSupabaseOrderOpsReadClient(client);
  const res = await loadOrderOpsData(adapter, { compute: REAL_COMPUTE });
  assert.equal(res.complete, false);
  assert.equal(res.scope, "partial");
  assert.equal(res.sources.shopify.status, "error");
  assert.equal(res.sources.shopify.errorCode, "shopify_read_failed");
  assert.equal(res.sources.shopify.ledger, "unavailable");
  assert.equal(res.sources.talabat.status, "ok");
  const json = JSON.stringify(res);
  for (const leak of ["builder boom", "SECRET", "42P01"]) assert.ok(!json.includes(leak), `leaked: ${leak}`);
});

test("integration: Supabase returns error object → classified safely, no raw leak", async () => {
  const { client } = fakeSupabase({
    shopify_synced_orders: { result: { data: null, error: { message: "SMSG", details: "SDET", code: "SCODE", hint: "SHINT" } } },
    talabat_orders: { result: { data: [], error: null } },
  });
  const adapter = createSupabaseOrderOpsReadClient(client);
  const res = await loadOrderOpsData(adapter, { compute: REAL_COMPUTE });
  assert.equal(res.sources.shopify.status, "error");
  assert.equal(res.sources.shopify.ledger, "unavailable");
  const json = JSON.stringify(res);
  for (const leak of ["SMSG", "SDET", "SCODE", "SHINT"]) assert.ok(!json.includes(leak), `leaked: ${leak}`);
});

test("integration: successful empty arrays → Shopify empty + no_synced_orders", async () => {
  const { client } = fakeSupabase({ talabat_orders: { result: { data: [], error: null } }, shopify_synced_orders: { result: { data: [], error: null } } });
  const adapter = createSupabaseOrderOpsReadClient(client);
  const res = await loadOrderOpsData(adapter, { compute: REAL_COMPUTE });
  assert.equal(res.complete, true);
  assert.equal(res.sources.shopify.status, "ok");
  assert.equal(res.sources.shopify.ledger, "empty");
  assert.equal(res.sources.shopify.ledgerReasonCode, "no_synced_orders");
});

// ── Source safety scan ───────────────────────────────────────────────────────

test("source (comments stripped) has no write/RPC/fetch/client-creation/env/logging", () => {
  const raw = readFileSync(new URL("./order-ops-supabase.ts", import.meta.url), "utf8");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const [re, msg] of [
    [/\bfetch\s*\(/, "fetch("],
    [/\.rpc\s*\(/, ".rpc("],
    [/\.insert\s*\(/, ".insert("],
    [/\.update\s*\(/, ".update("],
    [/\.upsert\s*\(/, ".upsert("],
    [/\.delete\s*\(/, ".delete("],
    [/createClient/, "createClient"],
    [/createAdminClient/, "createAdminClient"],
    [/service_role/, "service_role"],
    [/process\.env/, "process.env"],
    [/console\./, "console."],
  ] as const) {
    assert.ok(!re.test(src), `forbidden in source: ${msg}`);
  }
  // no Shopify/Talabat API module imports (only relative + server-only)
  assert.ok(!/from\s+["'][^"']*\/(admin|shopify\/admin|talabat)/.test(src), "no shopify/talabat API imports");
  assert.ok(!/from\s+["']@\//.test(src), "no @/ imports");
});
