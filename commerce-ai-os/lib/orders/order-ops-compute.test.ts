// Tests for the pure Unified Order Operations compute (Phase 2B.1).
// Run: node --conditions=react-server --experimental-strip-types --test lib/orders/order-ops-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  projectTalabatOrder,
  projectShopifyLedger,
  buildOrderOpsRows,
  summarizeOrderOps,
  classifyShopifyLedgerState,
  ORDER_OPS_ROW_KEYS,
  type OrderOpsRow,
  type SignalKind,
  type SignalState,
} from "./order-ops-compute.ts";

const signal = (row: OrderOpsRow, kind: SignalKind): SignalState =>
  row.signals.find((s) => s.kind === kind)?.state ?? ("MISSING" as SignalState);

// ── Talabat status normalization ─────────────────────────────────────────────

test("Talabat processed", () => {
  assert.equal(projectTalabatOrder({ id: "t1", processing_status: "processed" }).status, "processed");
});
test("Talabat pending", () => {
  assert.equal(projectTalabatOrder({ id: "t1", processing_status: "pending" }).status, "pending");
});
test("Talabat manual_review", () => {
  const r = projectTalabatOrder({ id: "t1", processing_status: "manual_review" });
  assert.equal(r.status, "manual_review");
  assert.equal(signal(r, "manual_review"), "flagged");
});
test("Talabat failed", () => {
  assert.equal(projectTalabatOrder({ id: "t1", processing_status: "failed" }).status, "failed");
});
test("Talabat unknown status", () => {
  const r = projectTalabatOrder({ id: "t1", processing_status: "weird" });
  assert.equal(r.status, "unknown");
  assert.equal(signal(r, "manual_review"), "unknown");
});

// ── Shopify status normalization ─────────────────────────────────────────────

test("Shopify processed", () => {
  const r = projectShopifyLedger({ order_id: "s1", processing_status: "completed", deducted: 2, deduction_result: { status: "processed", deducted: 2 } });
  assert.equal(r.status, "processed");
  assert.equal(signal(r, "under_deduction"), "clear");
});
test("Shopify baseline_recorded", () => {
  const r = projectShopifyLedger({ order_id: "s1", processing_status: "completed", deduction_result: { status: "baseline_recorded", deducted: 0 } });
  assert.equal(r.status, "baseline");
  assert.equal(r.reasonCode, "baseline_recorded");
  assert.equal(signal(r, "under_deduction"), "clear"); // baseline never deducts → not under-deduction
});
test("Shopify already_processed → processed", () => {
  const r = projectShopifyLedger({ order_id: "s1", processing_status: "completed", deduction_result: { status: "already_processed", deducted: 0 } });
  assert.equal(r.status, "processed");
  assert.equal(r.reasonCode, "already_processed");
});
test("Shopify pending", () => {
  const r = projectShopifyLedger({ order_id: "s1", processing_status: "pending" });
  assert.equal(r.status, "pending");
});
test("Shopify malformed deduction_result", () => {
  for (const bad of [[], "oops", 5, true]) {
    const r = projectShopifyLedger({ order_id: "s1", processing_status: "completed", deduction_result: bad as unknown });
    assert.equal(r.status, "unknown");
    assert.equal(signal(r, "malformed_result"), "flagged");
  }
});
test("Shopify completed WITHOUT a valid result does NOT become processed", () => {
  const r = projectShopifyLedger({ order_id: "s1", processing_status: "completed", deduction_result: null });
  assert.notEqual(r.status, "processed");
  assert.equal(r.status, "unknown");
  assert.equal(signal(r, "malformed_result"), "flagged");
});
test("Shopify confirmed error → failed", () => {
  const r = projectShopifyLedger({ order_id: "s1", processing_status: "completed", deduction_result: { status: "error" } });
  assert.equal(r.status, "failed");
});
test("Shopify block reason status → blocked", () => {
  const r = projectShopifyLedger({ order_id: "s1", deduction_result: { status: "unmatched_order" } });
  assert.equal(r.status, "blocked");
  assert.equal(signal(r, "blocked"), "flagged");
  assert.equal(signal(r, "unmatched"), "flagged");
});

// ── Channel attribution ──────────────────────────────────────────────────────

test("channel attribution talabat/shopify", () => {
  assert.equal(projectShopifyLedger({ order_id: "s1", channel: "talabat" }).channel, "talabat");
  assert.equal(projectShopifyLedger({ order_id: "s2", channel: "shopify" }).channel, "shopify");
  assert.equal(projectTalabatOrder({ id: "t1" }).channel, "talabat");
});
test("unknown channel fails safely (defaults to shopify, no throw)", () => {
  assert.doesNotThrow(() => projectShopifyLedger({ order_id: "s1", channel: "mars" as unknown as string }));
  assert.equal(projectShopifyLedger({ order_id: "s1", channel: "mars" as unknown as string }).channel, "shopify");
  assert.equal(projectShopifyLedger({ order_id: "s1", channel: null }).channel, "shopify");
});

// ── Reason whitelist ─────────────────────────────────────────────────────────

test("known reason whitelist (Talabat + Shopify)", () => {
  assert.equal(projectTalabatOrder({ id: "t1", processing_status: "manual_review", resolution: { reason: "ambiguous_match" } }).reasonCode, "ambiguous_match");
  assert.equal(projectShopifyLedger({ order_id: "s1", deduction_result: { status: "migration_required" } }).reasonCode, "migration_required");
});
test("unknown reason never leaks raw text", () => {
  const r = projectTalabatOrder({ id: "t1", processing_status: "failed", resolution: { reason: "SELECT * FROM secrets; drop table" } });
  assert.equal(r.reasonCode, "unknown_reason");
  const s = projectShopifyLedger({ order_id: "s1", deduction_result: { status: "some totally made up status" } });
  assert.equal(s.reasonCode, "unknown_reason");
  // the raw text must not appear anywhere in the projected rows
  assert.ok(!JSON.stringify(r).includes("secrets"));
  assert.ok(!JSON.stringify(s).includes("made up"));
});

// ── possible_duplicate ───────────────────────────────────────────────────────

test("duplicate exact identity flagged", () => {
  const rows = buildOrderOpsRows({
    shopify: [
      { order_id: "dup", order_name: "#1", deduction_result: { status: "processed", deducted: 1 }, deducted: 1 },
      { order_id: "dup", order_name: "#1", deduction_result: { status: "processed", deducted: 1 }, deducted: 1 },
    ],
  });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => signal(r, "possible_duplicate") === "flagged"));
});
test("similar (non-identical) names do NOT create a duplicate flag", () => {
  const rows = buildOrderOpsRows({
    shopify: [
      { order_id: "a", order_name: "#1167", deduction_result: { status: "processed", deducted: 1 }, deducted: 1 },
      { order_id: "b", order_name: "#1167-A", deduction_result: { status: "processed", deducted: 1 }, deducted: 1 },
    ],
  });
  assert.ok(rows.every((r) => signal(r, "possible_duplicate") === "clear"));
});

// ── under_deduction (evidence-based tri-state) ───────────────────────────────

test("under_deduction flagged only with sufficient numeric evidence", () => {
  const r = projectShopifyLedger({ order_id: "s1", deducted: 0, processing_status: "completed", deduction_result: { status: "processed", deducted: 0 } });
  assert.equal(r.status, "processed");
  assert.equal(signal(r, "under_deduction"), "flagged");
});
test("under_deduction unknown when numeric evidence missing", () => {
  const r = projectShopifyLedger({ order_id: "s1", processing_status: "completed", deduction_result: { status: "processed" } }); // no deducted anywhere
  assert.equal(r.status, "processed");
  assert.equal(signal(r, "under_deduction"), "unknown");
});
test("under_deduction clear for a healthy deduction", () => {
  const r = projectShopifyLedger({ order_id: "s1", deducted: 3, deduction_result: { status: "processed", deducted: 3 } });
  assert.equal(signal(r, "under_deduction"), "clear");
});

// ── void / refunded (only when explicitly supplied) ──────────────────────────

test("void/refunded classification when explicitly supplied", () => {
  assert.equal(signal(projectTalabatOrder({ id: "t1", processing_status: "processed", refunded: true }), "void_or_refunded"), "flagged");
  assert.equal(signal(projectTalabatOrder({ id: "t1", processing_status: "processed", refunded: false }), "void_or_refunded"), "clear");
  assert.equal(signal(projectTalabatOrder({ id: "t1", processing_status: "processed" }), "void_or_refunded"), "unknown");
});

// ── empty ledger ─────────────────────────────────────────────────────────────

test("empty Shopify ledger → no_synced_orders (no invented cause)", () => {
  assert.deepEqual(classifyShopifyLedgerState([]), { state: "empty", reason: "no_synced_orders" });
  assert.deepEqual(classifyShopifyLedgerState(null), { state: "empty", reason: "no_synced_orders" });
  assert.deepEqual(classifyShopifyLedgerState(undefined), { state: "empty", reason: "no_synced_orders" });
  // arbitrary/unknown supplied evidence is ignored (never leaks)
  assert.deepEqual(classifyShopifyLedgerState([], { reasonCode: "OAuth failed" }), { state: "empty", reason: "no_synced_orders" });
  // a whitelisted classified reason is honored
  assert.deepEqual(classifyShopifyLedgerState([], { reasonCode: "migration_required" }), { state: "empty", reason: "migration_required" });
  // populated
  assert.deepEqual(classifyShopifyLedgerState([{ order_id: "s1" }]), { state: "populated", reason: null });
});

// ── summary + deterministic ordering ─────────────────────────────────────────

test("summary counts", () => {
  const rows = buildOrderOpsRows({
    talabat: [
      { id: "t1", processing_status: "processed" },
      { id: "t2", processing_status: "manual_review", resolution: { reason: "unmatched" } },
      { id: "t3", processing_status: "failed", resolution: { reason: "processing_failed" } },
    ],
    shopify: [
      { order_id: "s1", deducted: 1, deduction_result: { status: "processed", deducted: 1 } },
      { order_id: "s2", deduction_result: { status: "unmatched_order" } }, // blocked
    ],
  });
  const sum = summarizeOrderOps(rows);
  assert.equal(sum.total, 5);
  assert.deepEqual(sum.bySource, { shopify: 2, talabat: 3 });
  assert.deepEqual(sum.byChannel, { shopify: 2, talabat: 3 });
  assert.equal(sum.byStatus.processed, 2);
  assert.equal(sum.byStatus.manual_review, 1);
  assert.equal(sum.byStatus.failed, 1);
  assert.equal(sum.byStatus.blocked, 1);
  assert.equal(sum.manualReview, 1);
  assert.equal(sum.failed, 1);
  assert.equal(sum.blocked, 1);
  assert.equal(sum.flagged, 2); // t2 (unmatched + manual_review) and s2 (blocked + unmatched); t3 failed has no flagged problem signal
});

test("deterministic ordering (stable regardless of input order)", () => {
  const a = buildOrderOpsRows({ shopify: [{ order_id: "b" }, { order_id: "a" }], talabat: [{ id: "z" }] });
  const b = buildOrderOpsRows({ talabat: [{ id: "z" }], shopify: [{ order_id: "a" }, { order_id: "b" }] });
  assert.deepEqual(
    a.map((r) => `${r.source}:${r.sourceOrderId}`),
    b.map((r) => `${r.source}:${r.sourceOrderId}`),
  );
  assert.deepEqual(a.map((r) => `${r.source}:${r.sourceOrderId}`), ["shopify:a", "shopify:b", "talabat:z"]);
});

// ── PII-safe projection ──────────────────────────────────────────────────────

const FORBIDDEN_KEYS = ["raw", "resolution", "deduction_result", "items", "customer", "phone", "email", "address", "token", "header", "payment_gateway_names"];

function collectKeys(v: unknown, acc: Set<string>): void {
  if (Array.isArray(v)) {
    for (const el of v) collectKeys(el, acc);
  } else if (v && typeof v === "object") {
    for (const k of Object.keys(v)) {
      acc.add(k);
      collectKeys((v as Record<string, unknown>)[k], acc);
    }
  }
}

test("no raw / resolution / deduction payload or PII keys are emitted", () => {
  const talabat = projectTalabatOrder({
    id: "t1",
    processing_status: "manual_review",
    resolution: { reason: "unmatched", customer: { phone: "+974xxxx", email: "a@b.c", address: "secret st" }, lines: [{ title: "raw title" }] },
    // hostile extra keys that must never be copied out
    ...( { raw: { anything: 1 }, token: "SECRET", authorization: "Bearer x", items: [1, 2] } as object ),
  } as never);
  const shopify = projectShopifyLedger({
    order_id: "s1",
    order_name: "#1",
    deduction_result: { status: "processed", deducted: 1, products: [{ product_id: "p", before: 5, after: 4 }] },
    deducted: 1,
    payment_gateway_names: ["Talabat"],
    ...( { raw: { x: 1 }, customer: { phone: "p" } } as object ),
  } as never);

  for (const row of [talabat, shopify]) {
    assert.deepEqual(Object.keys(row).sort(), [...ORDER_OPS_ROW_KEYS].sort());
    const keys = new Set<string>();
    collectKeys(row, keys);
    for (const bad of FORBIDDEN_KEYS) assert.ok(!keys.has(bad), `forbidden key leaked: ${bad}`);
    // nested sensitive values must not survive anywhere in the serialized row
    const json = JSON.stringify(row);
    for (const secret of ["+974xxxx", "a@b.c", "secret st", "SECRET", "Bearer", "raw title", "products", "before", "after"]) {
      assert.ok(!json.includes(secret), `sensitive value leaked: ${secret}`);
    }
  }
});

test("PII-like nested keys are not preserved even under deep hostile input", () => {
  const rows = buildOrderOpsRows({
    talabat: [{ id: "t1", resolution: { reason: "unmatched", nested: { deep: { phone: "x", token: "y" } } } } as never],
    shopify: [{ order_id: "s1", deduction_result: { status: "processed", deducted: 1, secretHeader: "h" }, deducted: 1 } as never],
  });
  const keys = new Set<string>();
  collectKeys(rows, keys);
  // NB: "status" is NOT checked here — it is a legitimate OrderOpsRow field.
  for (const bad of ["phone", "token", "secretHeader", "nested", "deep", "reason", "products"]) {
    assert.ok(!keys.has(bad), `leaked key: ${bad}`);
  }
});

// ── malformed / hostile input handled without throwing ───────────────────────

test("malformed arrays/objects/null handled without throwing", () => {
  assert.doesNotThrow(() => buildOrderOpsRows({ talabat: null, shopify: undefined }));
  assert.doesNotThrow(() => buildOrderOpsRows({ talabat: "nope" as never, shopify: 5 as never }));
  assert.doesNotThrow(() => buildOrderOpsRows({ talabat: [null as never, 5 as never, {} as never] }));
  assert.doesNotThrow(() => summarizeOrderOps(null as never));
  assert.doesNotThrow(() => summarizeOrderOps([null as never, "x" as never]));
  assert.doesNotThrow(() => projectTalabatOrder({ id: "t1", resolution: [] }));
  assert.doesNotThrow(() => projectShopifyLedger({ order_id: "s1", deduction_result: 12345 as unknown }));
  // resolution as a non-object → malformed flagged, no throw
  assert.equal(signal(projectTalabatOrder({ id: "t1", processing_status: "failed", resolution: [1, 2] }), "malformed_result"), "flagged");
});

// ── Source safety scan ───────────────────────────────────────────────────────

test("source (code, comments stripped) contains no network/db/server-only/imports", () => {
  const raw = readFileSync(new URL("./order-ops-compute.ts", import.meta.url), "utf8");
  // Strip block + line comments so documentation prose (which legitimately names
  // Supabase/server-only to say they are ABSENT) can't cause false positives.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(!/\bfetch\s*\(/.test(src), "must not call fetch(");
  assert.ok(!/supabase/i.test(src), "must not reference supabase in code");
  assert.ok(!/server-only/.test(src), "must not import server-only");
  assert.ok(!/^\s*import\s/m.test(src), "must have no imports at all (no @/, no clients)");
  assert.ok(!/\.rpc\s*\(/.test(src), "must not call any .rpc()");
  assert.ok(!/createAdminClient|createClient/.test(src), "must not create a DB client");
  assert.ok(!/Date\.now\s*\(/.test(src), "must not use Date.now()");
  assert.ok(!/\bnew Date\s*\(\s*\)/.test(src), "must not use argless new Date()");
});
