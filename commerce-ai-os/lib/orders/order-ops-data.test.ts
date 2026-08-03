// Tests for the read-only Order Operations data layer (Phase 2B.2).
// Run: node --conditions=react-server --experimental-strip-types --test lib/orders/order-ops-data.test.ts
//
// Uses a FAKE query client only — never touches a database.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  loadOrderOpsData,
  type OrderOpsQuery,
  type OrderOpsQueryResult,
  type OrderOpsReadClient,
  type OrderOpsDataResult,
} from "./order-ops-data.ts";
import { buildOrderOpsRows, summarizeOrderOps, classifyShopifyLedgerState } from "./order-ops-compute.ts";
import type { OrderOpsRow, SignalKind, SignalState } from "./order-ops-compute.ts";

// Inject the REAL Phase 2B.1 compute so rows are produced through buildOrderOpsRows
// (and so the module's lazy default dynamic import is never triggered under node:test).
const REAL_COMPUTE = { buildOrderOpsRows, summarizeOrderOps, classifyShopifyLedgerState };
const load = (client: OrderOpsReadClient, opts?: { limit?: number }): Promise<OrderOpsDataResult> =>
  loadOrderOpsData(client, { compute: REAL_COMPUTE, ...(opts ?? {}) });

const TALABAT_COLUMNS = "id, order_code, event, processing_status, processed_at, created_at:received_at, resolution";
const SHOPIFY_COLUMNS =
  "order_id, order_name, channel, payment_gateway_names, deducted, processing_status, processed_at, synced_at, deduction_result";

interface Responder {
  data?: unknown[] | null;
  error?: unknown;
  throws?: boolean;
}

function fakeClient(resp: { talabat_orders?: Responder; shopify_synced_orders?: Responder }) {
  const calls: OrderOpsQuery[] = [];
  const client: OrderOpsReadClient = {
    async query(q: OrderOpsQuery): Promise<OrderOpsQueryResult> {
      calls.push(q);
      const r = resp[q.table] ?? { data: [] };
      if (r.throws) throw new Error("boom DB SECRET at table x");
      return { data: r.data ?? null, error: r.error ?? null };
    },
  };
  return { client, calls };
}

const talabatRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "gid://shopify/TalabatOrder/1",
  order_code: "T-1",
  event: "order.created",
  processing_status: "processed",
  processed_at: "2026-08-01T00:00:00Z",
  created_at: "2026-08-01T00:00:00Z",
  resolution: { reason: "manual_review" },
  ...over,
});
const shopifyRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  order_id: "gid://shopify/Order/1",
  order_name: "#1",
  channel: "shopify",
  payment_gateway_names: ["Cash"],
  deducted: 1,
  processing_status: "completed",
  processed_at: "2026-08-01T00:00:00Z",
  synced_at: "2026-08-01T00:00:00Z",
  deduction_result: { status: "processed" },
  ...over,
});

const findByPrefix = (res: OrderOpsDataResult, source: "talabat" | "shopify"): OrderOpsRow | undefined =>
  res.rows.find((r) => r.source === source);
const signal = (row: OrderOpsRow, kind: SignalKind): SignalState =>
  row.signals.find((s) => s.kind === kind)?.state ?? ("MISSING" as SignalState);

const call = (calls: OrderOpsQuery[], table: OrderOpsQuery["table"]): OrderOpsQuery | undefined =>
  calls.find((c) => c.table === table);

// ── Happy path ───────────────────────────────────────────────────────────────

test("both sources succeed → complete, unified rows + summary", async () => {
  const { client } = fakeClient({ talabat_orders: { data: [talabatRow()] }, shopify_synced_orders: { data: [shopifyRow()] } });
  const res = await load(client);
  assert.equal(res.complete, true);
  assert.equal(res.scope, "complete");
  assert.equal(res.sources.talabat.status, "ok");
  assert.equal(res.sources.shopify.status, "ok");
  assert.equal(res.sources.shopify.ledger, "populated");
  assert.equal(res.rows.length, 2);
  assert.equal(res.summary.total, 2);
  assert.equal(res.sources.talabat.returned, 1);
  assert.equal(res.sources.shopify.returned, 1);
});

// ── Partial-source handling ──────────────────────────────────────────────────

test("Talabat ok / Shopify {error} → partial; shopify unavailable; only talabat rows; no raw error leak", async () => {
  const { client } = fakeClient({
    talabat_orders: { data: [talabatRow()] },
    shopify_synced_orders: { error: { message: "SECRET permission denied", code: "42P01", details: "d", hint: "h", stack: "st" } },
  });
  const res = await load(client);
  assert.equal(res.complete, false);
  assert.equal(res.scope, "partial");
  assert.equal(res.sources.shopify.status, "error");
  assert.equal(res.sources.shopify.errorCode, "shopify_read_failed");
  assert.equal(res.sources.shopify.ledger, "unavailable");
  assert.equal(res.sources.shopify.returned, 0);
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].source, "talabat");
  const json = JSON.stringify(res);
  for (const secret of ["SECRET", "42P01", "permission denied", "hint", "stack"]) assert.ok(!json.includes(secret), `leaked: ${secret}`);
});

test("Shopify ok / Talabat throws → partial; talabat error; only shopify rows; no exception leak", async () => {
  const { client } = fakeClient({ talabat_orders: { throws: true }, shopify_synced_orders: { data: [shopifyRow()] } });
  const res = await load(client);
  assert.equal(res.complete, false);
  assert.equal(res.scope, "partial");
  assert.equal(res.sources.talabat.status, "error");
  assert.equal(res.sources.talabat.errorCode, "talabat_read_failed");
  assert.equal(res.sources.shopify.status, "ok");
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].source, "shopify");
  assert.ok(!JSON.stringify(res).includes("boom"));
});

test("both fail → partial with empty rows", async () => {
  const { client } = fakeClient({ talabat_orders: { throws: true }, shopify_synced_orders: { error: { message: "x" } } });
  const res = await load(client);
  assert.equal(res.complete, false);
  assert.equal(res.scope, "partial");
  assert.equal(res.rows.length, 0);
  assert.equal(res.summary.total, 0);
  assert.equal(res.sources.talabat.status, "error");
  assert.equal(res.sources.shopify.status, "error");
  assert.equal(res.sources.shopify.ledger, "unavailable");
});

test("raw DB error text (message/details/hint/code/stack) never appears in the result", async () => {
  const { client } = fakeClient({
    talabat_orders: { error: { message: "TMSG", details: "TDET", hint: "THINT", code: "TCODE", stack: "TSTACK" } },
    shopify_synced_orders: { error: { message: "SMSG", details: "SDET", hint: "SHINT", code: "SCODE", stack: "SSTACK" } },
  });
  const res = await load(client);
  const json = JSON.stringify(res);
  for (const s of ["TMSG", "TDET", "THINT", "TCODE", "TSTACK", "SMSG", "SDET", "SHINT", "SCODE", "SSTACK"]) {
    assert.ok(!json.includes(s), `leaked: ${s}`);
  }
});

// ── Exact select whitelists ──────────────────────────────────────────────────

test("exact Talabat + Shopify select whitelists (no raw/items/customer/etc.)", async () => {
  const { client, calls } = fakeClient({});
  await load(client);
  assert.equal(call(calls, "talabat_orders")?.columns, TALABAT_COLUMNS);
  assert.equal(call(calls, "shopify_synced_orders")?.columns, SHOPIFY_COLUMNS);
  const both = `${TALABAT_COLUMNS} ${SHOPIFY_COLUMNS}`;
  for (const forbidden of ["raw", "items", "customer", "phone", "email", "address", "webhook"]) {
    assert.ok(!both.includes(forbidden), `forbidden column selected: ${forbidden}`);
  }
});

// ── Pagination + limits ──────────────────────────────────────────────────────

test("default limit 100 → fetches 101 (limit + 1) per source", async () => {
  const { client, calls } = fakeClient({});
  await load(client);
  assert.equal(call(calls, "talabat_orders")?.limit, 101);
  assert.equal(call(calls, "shopify_synced_orders")?.limit, 101);
});

test("maximum limit 200 → fetches 201; over-max is clamped", async () => {
  const { client, calls } = fakeClient({});
  await load(client, { limit: 500 });
  assert.equal(call(calls, "talabat_orders")?.limit, 201);
  assert.equal(call(calls, "shopify_synced_orders")?.limit, 201);
});

test("valid limit is honored and still fetches limit+1", async () => {
  const { client, calls } = fakeClient({});
  await load(client, { limit: 50 });
  assert.equal(call(calls, "talabat_orders")?.limit, 51);
});

test("invalid limits (fractional/negative/zero/NaN/unsafe) normalize to default 100 → 101", async () => {
  for (const bad of [1.5, -5, 0, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "50" as unknown as number]) {
    const { client, calls } = fakeClient({});
    await load(client, { limit: bad });
    assert.equal(call(calls, "talabat_orders")?.limit, 101, `limit=${String(bad)}`);
  }
});

test("hasMore reflects raw page rows > limit (not a full-table count)", async () => {
  // limit 1 → fetch 2; return 2 rows → hasMore true, only first row kept
  const { client } = fakeClient({
    talabat_orders: { data: [talabatRow({ id: "a" }), talabatRow({ id: "b" })] },
    shopify_synced_orders: { data: [shopifyRow({ order_id: "s" })] },
  });
  const res = await load(client, { limit: 1 });
  assert.equal(res.sources.talabat.hasMore, true);
  assert.equal(res.sources.talabat.returned, 1);
  assert.equal(res.sources.shopify.hasMore, false);
});

// ── Deterministic ordering ───────────────────────────────────────────────────

test("Talabat select aliases created_at:received_at (real column) — no bare created_at", async () => {
  const { client, calls } = fakeClient({});
  await load(client);
  const cols = call(calls, "talabat_orders")?.columns ?? "";
  assert.equal(cols, TALABAT_COLUMNS);
  assert.ok(cols.includes("created_at:received_at"), "aliases received_at to created_at");
  assert.ok(!/(^|[ ,])created_at([ ,]|$)/.test(cols), "no bare created_at column selected");
});

test("Talabat deterministic ordering: received_at desc, then id desc", async () => {
  const { client, calls } = fakeClient({});
  await load(client);
  assert.deepEqual(call(calls, "talabat_orders")?.orderBy, [
    { column: "received_at", ascending: false },
    { column: "id", ascending: false },
  ]);
});
test("Shopify deterministic ordering: synced_at desc, then order_id desc", async () => {
  const { client, calls } = fakeClient({});
  await load(client);
  assert.deepEqual(call(calls, "shopify_synced_orders")?.orderBy, [
    { column: "synced_at", ascending: false },
    { column: "order_id", ascending: false },
  ]);
});

// ── PII-safe projection ──────────────────────────────────────────────────────

test("extra DB keys, gateway names, and raw deduction_result never appear in the result", async () => {
  const { client } = fakeClient({
    talabat_orders: {
      data: [talabatRow({ secretExtra: "TX", customer: { phone: "+974", email: "a@b.c", address: "st" }, raw: { x: 1 } })],
    },
    shopify_synced_orders: {
      data: [
        shopifyRow({
          payment_gateway_names: ["Talabat", "SECRETGW"],
          deduction_result: { status: "processed", products: [{ product_id: "p", before: 5, after: 4 }], secretField: "SF" },
          customer: { phone: "p" },
          rawExtra: "RX",
        }),
      ],
    },
  });
  const res = await load(client);
  const json = JSON.stringify(res);
  for (const s of ["secretExtra", "TX", "+974", "a@b.c", "address", "SECRETGW", "payment_gateway_names", "products", "secretField", "SF", "rawExtra", "RX", "before", "after"]) {
    assert.ok(!json.includes(s), `leaked: ${s}`);
  }
  // deep key scan
  const keys = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const k of Object.keys(v)) { keys.add(k); walk((v as Record<string, unknown>)[k]); }
  };
  walk(res);
  for (const bad of ["resolution", "deduction_result", "payment_gateway_names", "customer", "phone", "email", "address", "raw", "products", "secretExtra", "secretField"]) {
    assert.ok(!keys.has(bad), `leaked key: ${bad}`);
  }
});

test("Talabat createdAt is preserved (from aliased received_at); received_at/raw never spread into output", async () => {
  const { client } = fakeClient({
    talabat_orders: {
      // The aliased PostgREST response arrives keyed as created_at; a misbehaving
      // source may also echo received_at/raw — neither may reach the unified row.
      data: [talabatRow({ created_at: "2026-07-15T12:00:00Z", received_at: "2026-07-15T12:00:00Z", raw: { body: "SECRETRAW" } })],
    },
  });
  const res = await load(client);
  const row = findByPrefix(res, "talabat")!;
  assert.equal(row.createdAt, "2026-07-15T12:00:00Z", "createdAt preserved through the pipeline");
  assert.ok(!JSON.stringify(res).includes("SECRETRAW"), "raw value never leaks");
  const keys = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const k of Object.keys(v)) { keys.add(k); walk((v as Record<string, unknown>)[k]); }
  };
  walk(res);
  assert.ok(!keys.has("received_at"), "received_at never appears as an output key");
  assert.ok(!keys.has("raw"), "raw never appears as an output key");
});

test("no DeductionEvidence fabricated → a processed Shopify row is under_deduction unknown", async () => {
  const { client } = fakeClient({ shopify_synced_orders: { data: [shopifyRow({ deducted: 0 })] } });
  const res = await load(client);
  const row = findByPrefix(res, "shopify")!;
  assert.equal(row.status, "processed");
  assert.equal(signal(row, "under_deduction"), "unknown");
});

// ── Shopify ledger states ────────────────────────────────────────────────────

test("successful empty Shopify (data:[]) → ledger empty + ledgerReasonCode no_synced_orders", async () => {
  const { client } = fakeClient({ talabat_orders: { data: [] }, shopify_synced_orders: { data: [] } });
  const res = await load(client);
  assert.equal(res.sources.shopify.status, "ok");
  assert.equal(res.sources.shopify.ledger, "empty");
  assert.equal(res.sources.shopify.ledgerReasonCode, "no_synced_orders");
  assert.equal(res.sources.shopify.returned, 0);
  assert.equal(res.complete, true);
});

test("populated Shopify → ledger populated + ledgerReasonCode null", async () => {
  const { client } = fakeClient({ shopify_synced_orders: { data: [shopifyRow()] } });
  const res = await load(client);
  assert.equal(res.sources.shopify.ledger, "populated");
  assert.equal(res.sources.shopify.ledgerReasonCode, null);
});

test("failed Shopify query → ledger unavailable + ledgerReasonCode null (never empty)", async () => {
  const { client } = fakeClient({ shopify_synced_orders: { error: { message: "x" } } });
  const res = await load(client);
  assert.equal(res.sources.shopify.ledger, "unavailable");
  assert.equal(res.sources.shopify.ledgerReasonCode, null);
  assert.equal(res.sources.shopify.errorCode, "shopify_read_failed");
  assert.notEqual(res.sources.shopify.ledger, "empty");
});

test("malformed-only Shopify rows → 2B.1 ledger semantics (empty) but the malformed row is surfaced", async () => {
  const { client } = fakeClient({ shopify_synced_orders: { data: [{ processing_status: "completed" }] } }); // no order_id
  const res = await load(client);
  assert.equal(res.sources.shopify.status, "ok");
  assert.equal(res.sources.shopify.ledger, "empty"); // no valid order_id → empty per 2B.1
  assert.equal(res.sources.shopify.ledgerReasonCode, "no_synced_orders");
  assert.equal(res.sources.shopify.returned, 1); // the malformed row is still a unified operational row
  const row = findByPrefix(res, "shopify")!;
  assert.equal(row.sourceOrderId, "");
  assert.equal(signal(row, "malformed_result"), "flagged");
});

// ── rows go through buildOrderOpsRows; summary scope ─────────────────────────

test("rows are produced through buildOrderOpsRows (signals present, deterministic order)", async () => {
  const { client } = fakeClient({
    talabat_orders: { data: [talabatRow({ id: "t" })] },
    shopify_synced_orders: { data: [shopifyRow({ order_id: "z" }), shopifyRow({ order_id: "a" })] },
  });
  const res = await load(client);
  assert.deepEqual(res.rows.map((r) => `${r.source}:${r.sourceOrderId}`), ["shopify:a", "shopify:z", "talabat:t"]);
  for (const r of res.rows) assert.ok(Array.isArray(r.signals) && r.signals.length > 0);
});

test("complete run marks summary scope complete; partial run marks partial", async () => {
  const okBoth = await load(fakeClient({ talabat_orders: { data: [talabatRow()] }, shopify_synced_orders: { data: [shopifyRow()] } }).client);
  assert.equal(okBoth.scope, "complete");
  const partial = await load(fakeClient({ talabat_orders: { data: [talabatRow()] }, shopify_synced_orders: { throws: true } }).client);
  assert.equal(partial.scope, "partial");
});

test("non-plain-object DB rows are ignored (not counted, no throw)", async () => {
  const { client } = fakeClient({ talabat_orders: { data: [null, 5, "x", ["a"], talabatRow({ id: "ok" })] as unknown[] } });
  const res = await load(client);
  assert.equal(res.sources.talabat.returned, 1);
  assert.equal(res.rows.filter((r) => r.source === "talabat").length, 1);
});

// ── Blocker 1: strict successful-query shape ─────────────────────────────────

test("malformed query shapes fail closed (data null/{}/string/undefined) → source error", async () => {
  const shapes = [
    { data: null, error: null },
    { data: {} as unknown as unknown[], error: null },
    { data: "bad" as unknown as unknown[], error: null },
    { data: undefined, error: null },
  ];
  for (const shape of shapes) {
    const { client } = fakeClient({ talabat_orders: shape as Responder, shopify_synced_orders: shape as Responder });
    const res = await load(client);
    assert.equal(res.sources.talabat.status, "error", `talabat ${JSON.stringify(shape)}`);
    assert.equal(res.sources.talabat.errorCode, "talabat_read_failed");
    assert.equal(res.sources.shopify.status, "error", `shopify ${JSON.stringify(shape)}`);
    assert.equal(res.sources.shopify.ledger, "unavailable");
    assert.equal(res.sources.shopify.ledgerReasonCode, null);
    assert.equal(res.complete, false);
    assert.equal(res.rows.length, 0);
  }
});

test("only data:[] is a successful empty read; error object + data:[] is a failure", async () => {
  const okEmpty = await load(fakeClient({ talabat_orders: { data: [] }, shopify_synced_orders: { data: [] } }).client);
  assert.equal(okEmpty.sources.talabat.status, "ok");
  assert.equal(okEmpty.sources.shopify.status, "ok");
  const errWithEmptyData = await load(fakeClient({ shopify_synced_orders: { data: [], error: { message: "x" } } }).client);
  assert.equal(errWithEmptyData.sources.shopify.status, "error");
  assert.equal(errWithEmptyData.sources.shopify.ledger, "unavailable");
});

test("non-object query result → source error (fail closed)", async () => {
  const client: OrderOpsReadClient = { async query() { return undefined as unknown as OrderOpsQueryResult; } };
  const res = await loadOrderOpsData(client, { compute: REAL_COMPUTE });
  assert.equal(res.sources.talabat.status, "error");
  assert.equal(res.sources.shopify.status, "error");
  assert.equal(res.sources.shopify.ledger, "unavailable");
});

// ── Blocker 2: valid-row pagination BEFORE slice ─────────────────────────────

test("[null, A, B] limit 2 → returned 2, hasMore false (junk row never displaces valid rows or fakes hasMore)", async () => {
  const { client } = fakeClient({ talabat_orders: { data: [null, talabatRow({ id: "A" }), talabatRow({ id: "B" })] as unknown[] } });
  const res = await load(client, { limit: 2 });
  assert.equal(res.sources.talabat.returned, 2);
  assert.equal(res.sources.talabat.hasMore, false);
  assert.deepEqual(res.rows.filter((r) => r.source === "talabat").map((r) => r.sourceOrderId).sort(), ["A", "B"]);
});

test("[A, null, B, C] limit 2 → valid page rows 3 → returned 2, hasMore true", async () => {
  const { client } = fakeClient({
    talabat_orders: { data: [talabatRow({ id: "A" }), null, talabatRow({ id: "B" }), talabatRow({ id: "C" })] as unknown[] },
  });
  const res = await load(client, { limit: 2 });
  assert.equal(res.sources.talabat.returned, 2);
  assert.equal(res.sources.talabat.hasMore, true);
});

test("plain malformed-ID rows remain page rows (counted, surfaced as malformed)", async () => {
  const { client } = fakeClient({ talabat_orders: { data: [{ processing_status: "failed" }, talabatRow({ id: "A" })] as unknown[] } });
  const res = await load(client, { limit: 5 });
  assert.equal(res.sources.talabat.returned, 2);
  const malformed = res.rows.find((r) => r.source === "talabat" && r.sourceOrderId === "");
  assert.ok(malformed);
  assert.equal(signal(malformed!, "malformed_result"), "flagged");
});

// ── Blocker 4: returned derives from unified rows ────────────────────────────

test("returned derives from unified rows: an injected compute dropping a row changes returned", async () => {
  const dropFirstCompute = {
    buildOrderOpsRows: (input: Parameters<typeof buildOrderOpsRows>[0]) => buildOrderOpsRows(input).slice(1), // drop one unified row
    summarizeOrderOps,
    classifyShopifyLedgerState,
  };
  const { client } = fakeClient({ shopify_synced_orders: { data: [shopifyRow({ order_id: "a" }), shopifyRow({ order_id: "b" })] } });
  const res = await loadOrderOpsData(client, { compute: dropFirstCompute });
  assert.equal(res.rows.length, 1); // 2 inputs, compute dropped 1
  assert.equal(res.sources.shopify.returned, 1); // reflects unified output, not input length
  assert.equal(res.summary.total, 1); // summary uses final unified rows too
});

// ── Source safety scan ───────────────────────────────────────────────────────

test("source (comments stripped) makes no write/RPC/fetch/log and selects no raw/PII columns", () => {
  const raw = readFileSync(new URL("./order-ops-data.ts", import.meta.url), "utf8");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(!/\bfetch\s*\(/.test(src), "no fetch(");
  assert.ok(!/\.rpc\s*\(/.test(src), "no .rpc(");
  assert.ok(!/\.insert\s*\(/.test(src), "no .insert(");
  assert.ok(!/\.update\s*\(/.test(src), "no .update(");
  assert.ok(!/\.upsert\s*\(/.test(src), "no .upsert(");
  assert.ok(!/\.delete\s*\(/.test(src), "no .delete(");
  assert.ok(!/createAdminClient|createClient/.test(src), "no DB client creation");
  assert.ok(!/console\./.test(src), "no console logging");
  // only relative + server-only imports (no Shopify/Talabat API modules, no @/ )
  assert.ok(!/from\s+["']@\//.test(src), "no @/ imports");
  assert.ok(!/from\s+["'][^"']*\/(admin|shopify\/admin|talabat)/.test(src), "no shopify/talabat API imports");
  // executable code must not name raw/PII fields (variable renames avoid false hits)
  for (const forbidden of [/\braw\b/i, /\bitems\b/i, /\bcustomer\b/i, /\bphone\b/i, /\bemail\b/i, /\baddress\b/i, /\bwebhook\b/i]) {
    assert.ok(!forbidden.test(src), `forbidden field word in code: ${forbidden}`);
  }
  assert.ok(!/\bString\s*\(/.test(src), "no String() coercion of ids");
});
