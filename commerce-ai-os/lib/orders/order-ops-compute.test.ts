// Tests for the pure Unified Order Operations compute (Phase 2B.1, hardened).
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

// ── Status normalization ─────────────────────────────────────────────────────

test("Talabat status normalization", () => {
  assert.equal(projectTalabatOrder({ id: "t1", processing_status: "processed" }).status, "processed");
  assert.equal(projectTalabatOrder({ id: "t1", processing_status: "pending" }).status, "pending");
  assert.equal(projectTalabatOrder({ id: "t1", processing_status: "manual_review" }).status, "manual_review");
  assert.equal(projectTalabatOrder({ id: "t1", processing_status: "failed" }).status, "failed");
  assert.equal(projectTalabatOrder({ id: "t1", processing_status: "weird" }).status, "unknown");
});

test("Shopify status normalization", () => {
  assert.equal(projectShopifyLedger({ order_id: "s1", deduction_result: { status: "processed" } }).status, "processed");
  assert.equal(projectShopifyLedger({ order_id: "s1", deduction_result: { status: "baseline_recorded" } }).status, "baseline");
  assert.equal(projectShopifyLedger({ order_id: "s1", deduction_result: { status: "already_processed" } }).status, "processed");
  assert.equal(projectShopifyLedger({ order_id: "s1", processing_status: "pending" }).status, "pending");
  assert.equal(projectShopifyLedger({ order_id: "s1", deduction_result: { status: "error" } }).status, "failed");
  assert.equal(projectShopifyLedger({ order_id: "s1", deduction_result: { status: "unmatched_order" } }).status, "blocked");
});

test("Shopify completed WITHOUT a valid result does NOT become processed", () => {
  const r = projectShopifyLedger({ order_id: "s1", processing_status: "completed", deduction_result: null });
  assert.equal(r.status, "unknown");
  assert.equal(signal(r, "malformed_result"), "flagged");
});

test("Shopify malformed deduction_result → unknown + malformed", () => {
  for (const bad of [[], "oops", 5, true]) {
    const r = projectShopifyLedger({ order_id: "s1", processing_status: "completed", deduction_result: bad as unknown });
    assert.equal(r.status, "unknown");
    assert.equal(signal(r, "malformed_result"), "flagged");
  }
});

// ── Blocker 1: under_deduction requires explicit unit evidence ───────────────

test("deducted row count zero ALONE → under_deduction unknown (row count is not units)", () => {
  const r = projectShopifyLedger({ order_id: "s1", deducted: 0, deduction_result: { status: "processed" } });
  assert.equal(r.status, "processed");
  assert.equal(r.deductedRows, 0);
  assert.equal(signal(r, "under_deduction"), "unknown");
});

test("already_processed with deducted 0 → NOT under_deduction flagged", () => {
  const r = projectShopifyLedger({ order_id: "s1", deducted: 0, deduction_result: { status: "already_processed" } });
  assert.equal(r.status, "processed");
  assert.notEqual(signal(r, "under_deduction"), "flagged");
});

test("processed void/refunded with deducted 0 → NOT falsely under_deduction", () => {
  const r = projectShopifyLedger({ order_id: "s1", deducted: 0, refunded: true, deduction_result: { status: "processed" } });
  assert.equal(signal(r, "under_deduction"), "clear");
  assert.equal(signal(r, "void_or_refunded"), "flagged");
});

test("explicit evidence expected=3 applied=1 → under_deduction flagged", () => {
  const r = projectShopifyLedger({ order_id: "s1", deduction_result: { status: "processed" }, evidence: { expectedUnits: 3, appliedUnits: 1 } });
  assert.equal(signal(r, "under_deduction"), "flagged");
});
test("explicit evidence expected=3 applied=3 → under_deduction clear", () => {
  const r = projectShopifyLedger({ order_id: "s1", deduction_result: { status: "processed" }, evidence: { expectedUnits: 3, appliedUnits: 3 } });
  assert.equal(signal(r, "under_deduction"), "clear");
});
test("missing evidence → under_deduction unknown", () => {
  const r = projectShopifyLedger({ order_id: "s1", deduction_result: { status: "processed" }, evidence: { expectedUnits: 3, appliedUnits: null } });
  assert.equal(signal(r, "under_deduction"), "unknown");
  const r2 = projectShopifyLedger({ order_id: "s1", deduction_result: { status: "processed" } });
  assert.equal(signal(r2, "under_deduction"), "unknown");
});
test("baseline never flags under_deduction", () => {
  const r = projectShopifyLedger({ order_id: "s1", deducted: 0, deduction_result: { status: "baseline_recorded" }, evidence: { expectedUnits: 5, appliedUnits: 0 } });
  assert.equal(signal(r, "under_deduction"), "clear");
});

// ── Blocker 2: unknown deducted preserved as null (never 0) ───────────────────

test("Talabat deductedRows is null (no reliable measurement)", () => {
  assert.equal(projectTalabatOrder({ id: "t1", processing_status: "processed" }).deductedRows, null);
});
test("missing Shopify deducted → null", () => {
  assert.equal(projectShopifyLedger({ order_id: "s1" }).deductedRows, null);
});
test("negative / NaN / Infinity deducted → null; valid finite → number", () => {
  assert.equal(projectShopifyLedger({ order_id: "s1", deducted: -1 }).deductedRows, null);
  assert.equal(projectShopifyLedger({ order_id: "s1", deducted: Number.NaN }).deductedRows, null);
  assert.equal(projectShopifyLedger({ order_id: "s1", deducted: Number.POSITIVE_INFINITY }).deductedRows, null);
  assert.equal(projectShopifyLedger({ order_id: "s1", deducted: 3 }).deductedRows, 3);
  assert.equal(projectShopifyLedger({ order_id: "s1", deducted: 0 }).deductedRows, 0);
});

// ── Blocker 3: channel attribution fails closed ──────────────────────────────

test("unknown/absent channel with no gateway evidence → unknown (not shopify)", () => {
  assert.equal(projectShopifyLedger({ order_id: "s1", channel: "mars" as unknown as string }).channel, "unknown");
  assert.equal(projectShopifyLedger({ order_id: "s1", channel: null }).channel, "unknown");
  assert.equal(projectShopifyLedger({ order_id: "s1" }).channel, "unknown");
});
test("explicit shopify channel (no contradicting gateway) → shopify", () => {
  assert.equal(projectShopifyLedger({ order_id: "s1", channel: "shopify" }).channel, "shopify");
});
test("missing channel + Talabat gateway → talabat", () => {
  const r = projectShopifyLedger({ order_id: "s1", payment_gateway_names: [" TALABAT "] });
  assert.equal(r.channel, "talabat");
  assert.equal(signal(r, "channel_attribution_mismatch"), "clear");
});
test("saved shopify channel + Talabat gateway → mismatch + unknown", () => {
  const r = projectShopifyLedger({ order_id: "s1", channel: "shopify", payment_gateway_names: ["Talabat"] });
  assert.equal(r.channel, "unknown");
  assert.equal(signal(r, "channel_attribution_mismatch"), "flagged");
});
test("saved talabat channel + non-Talabat gateway → mismatch + unknown", () => {
  const r = projectShopifyLedger({ order_id: "s1", channel: "talabat", payment_gateway_names: ["Cash"] });
  assert.equal(r.channel, "unknown");
  assert.equal(signal(r, "channel_attribution_mismatch"), "flagged");
});
test("Talabat source is always the talabat channel", () => {
  assert.equal(projectTalabatOrder({ id: "t1" }).channel, "talabat");
});

// ── Reason whitelist ─────────────────────────────────────────────────────────

test("known reason whitelist (Talabat + Shopify)", () => {
  assert.equal(projectTalabatOrder({ id: "t1", processing_status: "manual_review", resolution: { reason: "ambiguous_match" } }).reasonCode, "ambiguous_match");
  assert.equal(projectShopifyLedger({ order_id: "s1", deduction_result: { status: "migration_required" } }).reasonCode, "migration_required");
});
test("unknown reason never leaks raw text", () => {
  const r = projectTalabatOrder({ id: "t1", processing_status: "failed", resolution: { reason: "DROP TABLE secrets" } });
  assert.equal(r.reasonCode, "unknown_reason");
  assert.ok(!JSON.stringify(r).includes("secrets"));
  const s = projectShopifyLedger({ order_id: "s1", deduction_result: { status: "totally made up" } });
  assert.equal(s.reasonCode, "unknown_reason");
  assert.ok(!JSON.stringify(s).includes("made up"));
});

// ── Blocker 4: malformed identities & false duplicates ───────────────────────

test("object ID is never stringified (no [object Object]); marked malformed, empty id", () => {
  const r = projectShopifyLedger({ order_id: { a: 1 } as unknown });
  assert.equal(r.sourceOrderId, "");
  assert.equal(signal(r, "malformed_result"), "flagged");
  assert.ok(!JSON.stringify(r).includes("[object Object]"));
  assert.ok(!JSON.stringify(r).includes('"a"'));
});
test("throwing toString / Symbol.toPrimitive on an id does not throw and does not leak", () => {
  const hostile = {
    toString() {
      throw new Error("boom");
    },
    [Symbol.toPrimitive]() {
      throw new Error("boom");
    },
  } as unknown;
  assert.doesNotThrow(() => projectShopifyLedger({ order_id: hostile }));
  assert.doesNotThrow(() => projectTalabatOrder({ id: hostile }));
  const r = projectShopifyLedger({ order_id: hostile });
  assert.equal(r.sourceOrderId, "");
  assert.equal(signal(r, "malformed_result"), "flagged");
});
test("boolean / number / array / null ids are not stringified", () => {
  for (const bad of [true, 42, ["x"], null, undefined]) {
    const r = projectShopifyLedger({ order_id: bad as unknown });
    assert.equal(r.sourceOrderId, "");
    assert.equal(signal(r, "malformed_result"), "flagged");
  }
});
test("two missing/malformed IDs are NOT duplicates", () => {
  const rows = buildOrderOpsRows({ shopify: [{ order_id: null }, { order_id: { x: 1 } as unknown }] });
  assert.ok(rows.every((r) => signal(r, "possible_duplicate") === "clear"));
});
test("two valid equal IDs ARE duplicates", () => {
  const rows = buildOrderOpsRows({ shopify: [{ order_id: "dup" }, { order_id: "dup" }] });
  assert.ok(rows.every((r) => signal(r, "possible_duplicate") === "flagged"));
});
test("same display name with different IDs is NOT a duplicate (order_name is display-only)", () => {
  const rows = buildOrderOpsRows({ shopify: [{ order_id: "a", order_name: "#1" }, { order_id: "b", order_name: "#1" }] });
  assert.ok(rows.every((r) => signal(r, "possible_duplicate") === "clear"));
});
test("ID-derived display code is never a second duplicate key", () => {
  const rows = buildOrderOpsRows({ talabat: [{ id: "x1" }, { id: "x2" }] });
  assert.ok(rows.every((r) => signal(r, "possible_duplicate") === "clear"));
});

// ── Empty-ledger hardening ───────────────────────────────────────────────────

test("empty ledger with null/malformed/no-id rows remains empty", () => {
  assert.deepEqual(classifyShopifyLedgerState([]), { state: "empty", reason: "no_synced_orders" });
  assert.deepEqual(classifyShopifyLedgerState([null as unknown as never]), { state: "empty", reason: "no_synced_orders" });
  assert.deepEqual(classifyShopifyLedgerState([{} as never]), { state: "empty", reason: "no_synced_orders" });
  assert.deepEqual(classifyShopifyLedgerState([{ order_id: "" } as never]), { state: "empty", reason: "no_synced_orders" });
  assert.deepEqual(classifyShopifyLedgerState(["x" as unknown as never]), { state: "empty", reason: "no_synced_orders" });
  assert.deepEqual(classifyShopifyLedgerState(null), { state: "empty", reason: "no_synced_orders" });
  assert.deepEqual(classifyShopifyLedgerState([], { reasonCode: "OAuth failed" }), { state: "empty", reason: "no_synced_orders" });
  assert.deepEqual(classifyShopifyLedgerState([], { reasonCode: "migration_required" }), { state: "empty", reason: "migration_required" });
  assert.deepEqual(classifyShopifyLedgerState([{ order_id: "s1" }]), { state: "populated", reason: null });
});

// ── Summary semantics ────────────────────────────────────────────────────────

test("summary: failed/blocked/manual_review count as flagged; byChannel has unknown; each row once", () => {
  const rows = buildOrderOpsRows({
    talabat: [
      { id: "t1", processing_status: "processed" }, // not flagged
      { id: "t2", processing_status: "manual_review", resolution: { reason: "unmatched" } }, // flagged (status + unmatched) → once
      { id: "t3", processing_status: "failed", resolution: { reason: "processing_failed" } }, // flagged by status
    ],
    shopify: [
      { order_id: "s1", channel: "shopify", deducted: 1, deduction_result: { status: "processed" } }, // not flagged
      { order_id: "s2", deduction_result: { status: "unmatched_order" } }, // blocked → flagged; channel unknown (no channel/gateway)
      { order_id: "s3", channel: "shopify", payment_gateway_names: ["Talabat"] }, // mismatch → flagged; channel unknown
    ],
  });
  const sum = summarizeOrderOps(rows);
  assert.equal(sum.total, 6);
  assert.deepEqual(sum.bySource, { shopify: 3, talabat: 3 });
  assert.deepEqual(sum.byChannel, { shopify: 1, talabat: 3, unknown: 2 });
  assert.equal(sum.manualReview, 1);
  assert.equal(sum.failed, 1);
  assert.equal(sum.blocked, 1);
  assert.equal(sum.flagged, 4); // t2, t3, s2, s3 (each counted once)
});

test("byChannel always contains the unknown key", () => {
  const sum = summarizeOrderOps([]);
  assert.ok("unknown" in sum.byChannel);
  assert.equal(sum.byChannel.unknown, 0);
});

// ── deterministic ordering ───────────────────────────────────────────────────

test("deterministic ordering regardless of input order", () => {
  const a = buildOrderOpsRows({ shopify: [{ order_id: "b" }, { order_id: "a" }], talabat: [{ id: "z" }] });
  const b = buildOrderOpsRows({ talabat: [{ id: "z" }], shopify: [{ order_id: "a" }, { order_id: "b" }] });
  assert.deepEqual(a.map((r) => `${r.source}:${r.sourceOrderId}`), b.map((r) => `${r.source}:${r.sourceOrderId}`));
  assert.deepEqual(a.map((r) => `${r.source}:${r.sourceOrderId}`), ["shopify:a", "shopify:b", "talabat:z"]);
});

// ── PII-safe projection ──────────────────────────────────────────────────────

const FORBIDDEN_KEYS = ["raw", "resolution", "deduction_result", "items", "customer", "phone", "email", "address", "token", "header", "payment_gateway_names", "products", "reason"];

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

test("gateway values are NOT projected and no raw/PII keys are emitted", () => {
  const talabat = projectTalabatOrder({
    id: "t1",
    processing_status: "manual_review",
    resolution: { reason: "unmatched", customer: { phone: "+974xxxx", email: "a@b.c", address: "secret st" }, lines: [{ title: "raw title" }] },
    ...( { raw: { anything: 1 }, token: "SECRET", authorization: "Bearer x", items: [1, 2] } as object ),
  } as never);
  const shopify = projectShopifyLedger({
    order_id: "s1",
    order_name: "#1",
    channel: "shopify",
    payment_gateway_names: ["Talabat", "SECRETGW"],
    deduction_result: { status: "processed", products: [{ product_id: "p", before: 5, after: 4 }] },
    deducted: 1,
    ...( { raw: { x: 1 }, customer: { phone: "p" } } as object ),
  } as never);

  for (const row of [talabat, shopify]) {
    assert.deepEqual(Object.keys(row).sort(), [...ORDER_OPS_ROW_KEYS].sort());
    const keys = new Set<string>();
    collectKeys(row, keys);
    for (const bad of FORBIDDEN_KEYS) assert.ok(!keys.has(bad), `forbidden key leaked: ${bad}`);
    const json = JSON.stringify(row);
    for (const secret of ["+974xxxx", "a@b.c", "secret st", "SECRET", "Bearer", "raw title", "SECRETGW", "products", "before", "after"]) {
      assert.ok(!json.includes(secret), `sensitive value leaked: ${secret}`);
    }
  }
});

test("PII-like nested keys are not preserved under deep hostile input", () => {
  const rows = buildOrderOpsRows({
    talabat: [{ id: "t1", resolution: { reason: "unmatched", nested: { deep: { phone: "x", token: "y" } } } } as never],
    shopify: [{ order_id: "s1", deduction_result: { status: "processed", secretHeader: "h" }, deducted: 1 } as never],
  });
  const keys = new Set<string>();
  collectKeys(rows, keys);
  // NB: "status" is a legitimate OrderOpsRow field and is not checked here.
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
  assert.equal(signal(projectTalabatOrder({ id: "t1", processing_status: "failed", resolution: [1, 2] }), "malformed_result"), "flagged");
});

// ── Source safety scan ───────────────────────────────────────────────────────

test("source (code, comments stripped) contains no network/db/server-only/imports/coercion", () => {
  const raw = readFileSync(new URL("./order-ops-compute.ts", import.meta.url), "utf8");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(!/\bfetch\s*\(/.test(src), "must not call fetch(");
  assert.ok(!/supabase/i.test(src), "must not reference supabase in code");
  assert.ok(!/server-only/.test(src), "must not import server-only");
  assert.ok(!/^\s*import\s/m.test(src), "must have no imports at all (no @/, no clients)");
  assert.ok(!/\.rpc\s*\(/.test(src), "must not call any .rpc()");
  assert.ok(!/createAdminClient|createClient/.test(src), "must not create a DB client");
  assert.ok(!/Date\.now\s*\(/.test(src), "must not use Date.now()");
  assert.ok(!/\bnew Date\s*\(\s*\)/.test(src), "must not use argless new Date()");
  assert.ok(!/\bString\s*\(/.test(src), "must not use the String() coercion constructor on untrusted ids");
});
