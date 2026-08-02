// Tests for the pure Order Operations view layer + page safety scan (Phase 2B.3B).
// Run: node --conditions=react-server --experimental-strip-types --test lib/orders/order-ops-view.test.ts
//
// PURE tests only — no database, no network, no Supabase, no Next runtime.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_FILTERS,
  parseOrderOpsViewFilters,
  filterOrderOpsRows,
  sortOrderOpsRows,
  summarizeVisibleRows,
  isMalformedIdentity,
  visibleSignals,
  getSourceLabel,
  getChannelLabel,
  getStatusLabel,
  getSignalKindLabel,
  getSignalStateLabel,
  getReasonLabel,
  formatOrderOpsDate,
  SOURCE_OPTIONS,
  CHANNEL_OPTIONS,
  STATUS_OPTIONS,
  ATTENTION_OPTIONS,
} from "./order-ops-view.ts";
import type {
  OrderOpsRow,
  OrderOpsStatus,
  ReconciliationSignal,
  SignalKind,
} from "./order-ops-compute.ts";

// ── Row builder ──────────────────────────────────────────────────────────────

function row(over: Partial<OrderOpsRow> = {}): OrderOpsRow {
  return {
    source: "talabat",
    sourceOrderId: "T1",
    displayOrderCode: "TAL-1",
    channel: "talabat",
    status: "processed",
    reasonCode: null,
    deductedRows: 1,
    createdAt: "2024-01-01T00:00:00Z",
    processedAt: null,
    signals: [],
    ...over,
  };
}
function sig(kind: SignalKind, state: ReconciliationSignal["state"]): ReconciliationSignal {
  return { kind, state };
}

// ── parseOrderOpsViewFilters ─────────────────────────────────────────────────

test("empty params → default filters", () => {
  assert.deepEqual(parseOrderOpsViewFilters({}), DEFAULT_FILTERS);
  assert.deepEqual(parseOrderOpsViewFilters(null), DEFAULT_FILTERS);
  assert.deepEqual(parseOrderOpsViewFilters(undefined), DEFAULT_FILTERS);
});

test("unknown filter values fall back to 'all' (never reflected)", () => {
  const f = parseOrderOpsViewFilters({
    source: "hacker",
    channel: "../etc",
    status: "DROP TABLE",
    attention: "weird",
  });
  assert.equal(f.source, "all");
  assert.equal(f.channel, "all");
  assert.equal(f.status, "all");
  assert.equal(f.attention, "all");
});

test("array params pick the first string; non-string members ignored", () => {
  const f = parseOrderOpsViewFilters({ source: ["shopify", "talabat"] });
  assert.equal(f.source, "shopify");
  // array with no usable string → fallback
  const g = parseOrderOpsViewFilters({ status: [] });
  assert.equal(g.status, "all");
});

test("query is trimmed", () => {
  assert.equal(parseOrderOpsViewFilters({ query: "  TAL-9  " }).query, "TAL-9");
});

test("query is capped at 80 characters", () => {
  const long = "a".repeat(200);
  assert.equal(parseOrderOpsViewFilters({ query: long }).query.length, 80);
});

test("non-string query is never coerced (no String())", () => {
  assert.equal(parseOrderOpsViewFilters({ query: 123 as unknown as string }).query, "");
  assert.equal(parseOrderOpsViewFilters({ query: { a: 1 } as unknown as string }).query, "");
});

// ── filterOrderOpsRows ───────────────────────────────────────────────────────

test("filter by source", () => {
  const rows = [row({ source: "talabat" }), row({ source: "shopify", sourceOrderId: "S1" })];
  const out = filterOrderOpsRows(rows, { ...DEFAULT_FILTERS, source: "shopify" });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.source, "shopify");
});

test("filter by channel", () => {
  const rows = [row({ channel: "talabat" }), row({ channel: "shopify" }), row({ channel: "unknown" })];
  const out = filterOrderOpsRows(rows, { ...DEFAULT_FILTERS, channel: "unknown" });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.channel, "unknown");
});

test("filter by every status value", () => {
  const statuses: OrderOpsStatus[] = [
    "pending",
    "processed",
    "baseline",
    "manual_review",
    "failed",
    "blocked",
    "unknown",
  ];
  const rows = statuses.map((s) => row({ status: s, sourceOrderId: `id-${s}` }));
  for (const s of statuses) {
    const out = filterOrderOpsRows(rows, { ...DEFAULT_FILTERS, status: s });
    assert.equal(out.length, 1, `status ${s}`);
    assert.equal(out[0]!.status, s);
  }
});

test("attention: flagged matches any flagged signal", () => {
  const rows = [
    row({ sourceOrderId: "a", signals: [sig("unmatched", "flagged")] }),
    row({ sourceOrderId: "b", signals: [sig("unmatched", "clear")] }),
    row({ sourceOrderId: "c", signals: [] }),
  ];
  const out = filterOrderOpsRows(rows, { ...DEFAULT_FILTERS, attention: "flagged" });
  assert.deepEqual(out.map((r) => r.sourceOrderId), ["a"]);
});

test("attention: manual_review matches flagged signal OR status", () => {
  const rows = [
    row({ sourceOrderId: "a", status: "manual_review" }),
    row({ sourceOrderId: "b", status: "processed", signals: [sig("manual_review", "flagged")] }),
    row({ sourceOrderId: "c", status: "processed" }),
  ];
  const out = filterOrderOpsRows(rows, { ...DEFAULT_FILTERS, attention: "manual_review" });
  assert.deepEqual(out.map((r) => r.sourceOrderId).sort(), ["a", "b"]);
});

test("attention: unmatched matches only the flagged unmatched signal", () => {
  const rows = [
    row({ sourceOrderId: "a", signals: [sig("unmatched", "flagged")] }),
    row({ sourceOrderId: "b", signals: [sig("possible_duplicate", "flagged")] }),
  ];
  const out = filterOrderOpsRows(rows, { ...DEFAULT_FILTERS, attention: "unmatched" });
  assert.deepEqual(out.map((r) => r.sourceOrderId), ["a"]);
});

test("attention: blocked matches flagged signal OR status", () => {
  const rows = [
    row({ sourceOrderId: "a", status: "blocked" }),
    row({ sourceOrderId: "b", status: "processed", signals: [sig("blocked", "flagged")] }),
    row({ sourceOrderId: "c", status: "processed" }),
  ];
  const out = filterOrderOpsRows(rows, { ...DEFAULT_FILTERS, attention: "blocked" });
  assert.deepEqual(out.map((r) => r.sourceOrderId).sort(), ["a", "b"]);
});

test("attention: malformed matches only flagged malformed_result signal", () => {
  const rows = [
    row({ sourceOrderId: "a", signals: [sig("malformed_result", "flagged")] }),
    row({ sourceOrderId: "b", signals: [sig("malformed_result", "clear")] }),
  ];
  const out = filterOrderOpsRows(rows, { ...DEFAULT_FILTERS, attention: "malformed" });
  assert.deepEqual(out.map((r) => r.sourceOrderId), ["a"]);
});

test("attention: channel_mismatch matches only flagged channel_attribution_mismatch", () => {
  const rows = [
    row({ sourceOrderId: "a", signals: [sig("channel_attribution_mismatch", "flagged")] }),
    row({ sourceOrderId: "b", signals: [sig("unmatched", "flagged")] }),
  ];
  const out = filterOrderOpsRows(rows, { ...DEFAULT_FILTERS, attention: "channel_mismatch" });
  assert.deepEqual(out.map((r) => r.sourceOrderId), ["a"]);
});

test("combined filters are ANDed", () => {
  const rows = [
    row({ sourceOrderId: "a", source: "shopify", status: "failed", displayOrderCode: "X-1" }),
    row({ sourceOrderId: "b", source: "shopify", status: "processed", displayOrderCode: "X-2" }),
    row({ sourceOrderId: "c", source: "talabat", status: "failed", displayOrderCode: "X-3" }),
  ];
  const out = filterOrderOpsRows(rows, { ...DEFAULT_FILTERS, source: "shopify", status: "failed" });
  assert.deepEqual(out.map((r) => r.sourceOrderId), ["a"]);
});

test("query searches displayOrderCode (case-insensitive)", () => {
  const rows = [row({ displayOrderCode: "TAL-777", sourceOrderId: "zzz" }), row({ displayOrderCode: "OTHER" })];
  const out = filterOrderOpsRows(rows, { ...DEFAULT_FILTERS, query: "tal-777" });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.displayOrderCode, "TAL-777");
});

test("query searches sourceOrderId", () => {
  const rows = [row({ sourceOrderId: "ABC123", displayOrderCode: "no-match" }), row({ sourceOrderId: "XYZ" })];
  const out = filterOrderOpsRows(rows, { ...DEFAULT_FILTERS, query: "abc123" });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.sourceOrderId, "ABC123");
});

test("query does NOT search reasonCode", () => {
  const rows = [row({ reasonCode: "insufficient_stock", displayOrderCode: "code", sourceOrderId: "id" })];
  const out = filterOrderOpsRows(rows, { ...DEFAULT_FILTERS, query: "insufficient_stock" });
  assert.equal(out.length, 0);
});

// ── sortOrderOpsRows ─────────────────────────────────────────────────────────

test("sort: newest createdAt first", () => {
  const rows = [
    row({ sourceOrderId: "old", createdAt: "2020-01-01T00:00:00Z" }),
    row({ sourceOrderId: "new", createdAt: "2024-06-01T00:00:00Z" }),
    row({ sourceOrderId: "mid", createdAt: "2022-03-01T00:00:00Z" }),
  ];
  const out = sortOrderOpsRows(rows);
  assert.deepEqual(out.map((r) => r.sourceOrderId), ["new", "mid", "old"]);
});

test("sort: falls back to processedAt when createdAt is missing", () => {
  const rows = [
    row({ sourceOrderId: "a", createdAt: null, processedAt: "2021-01-01T00:00:00Z" }),
    row({ sourceOrderId: "b", createdAt: null, processedAt: "2023-01-01T00:00:00Z" }),
  ];
  const out = sortOrderOpsRows(rows);
  assert.deepEqual(out.map((r) => r.sourceOrderId), ["b", "a"]);
});

test("sort: invalid/missing dates sort last", () => {
  const rows = [
    row({ sourceOrderId: "bad", createdAt: "not-a-date", processedAt: null }),
    row({ sourceOrderId: "good", createdAt: "2023-01-01T00:00:00Z" }),
    row({ sourceOrderId: "none", createdAt: null, processedAt: null }),
  ];
  const out = sortOrderOpsRows(rows);
  assert.equal(out[0]!.sourceOrderId, "good");
  assert.deepEqual(out.slice(1).map((r) => r.sourceOrderId).sort(), ["bad", "none"]);
});

test("sort: deterministic tie-break source → sourceOrderId → displayOrderCode", () => {
  const t = "2023-01-01T00:00:00Z";
  const rows = [
    row({ source: "talabat", sourceOrderId: "b", displayOrderCode: "z", createdAt: t }),
    row({ source: "shopify", sourceOrderId: "b", displayOrderCode: "a", createdAt: t }),
    row({ source: "shopify", sourceOrderId: "a", displayOrderCode: "q", createdAt: t }),
  ];
  const out = sortOrderOpsRows(rows);
  assert.deepEqual(
    out.map((r) => `${r.source}/${r.sourceOrderId}`),
    ["shopify/a", "shopify/b", "talabat/b"],
  );
});

test("filter and sort do not mutate the input array", () => {
  const rows = [
    row({ sourceOrderId: "a", createdAt: "2020-01-01T00:00:00Z" }),
    row({ sourceOrderId: "b", createdAt: "2024-01-01T00:00:00Z" }),
  ];
  const snapshot = JSON.parse(JSON.stringify(rows));
  const sorted = sortOrderOpsRows(rows);
  filterOrderOpsRows(rows, { ...DEFAULT_FILTERS, source: "shopify" });
  assert.deepEqual(rows, snapshot, "input not mutated");
  assert.notEqual(sorted, rows, "sort returns a new array");
});

// ── summarizeVisibleRows ─────────────────────────────────────────────────────

test("summary counts rows, not signals; each row needing attention once", () => {
  const rows = [
    row({ sourceOrderId: "a", signals: [sig("unmatched", "flagged"), sig("blocked", "flagged"), sig("manual_review", "flagged")] }),
    row({ sourceOrderId: "b", status: "manual_review" }),
    row({ sourceOrderId: "c", status: "failed", source: "shopify", channel: "shopify" }),
    row({ sourceOrderId: "d", status: "blocked", channel: "unknown" }),
  ];
  const s = summarizeVisibleRows(rows);
  assert.equal(s.visibleTotal, 4);
  assert.equal(s.needsAttention, 1, "row a counted once despite 3 flagged signals");
  assert.equal(s.manualReview, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.blocked, 1);
  assert.equal(s.talabat, 3);
  assert.equal(s.shopify, 1);
  assert.equal(s.unknownChannel, 1);
});

test("summary contract exposes only known aggregate keys (no PII/raw)", () => {
  const s = summarizeVisibleRows([row()]);
  assert.deepEqual(
    Object.keys(s).sort(),
    ["blocked", "failed", "manualReview", "needsAttention", "shopify", "talabat", "unknownChannel", "visibleTotal"].sort(),
  );
});

// ── identity / signal helpers ────────────────────────────────────────────────

test("isMalformedIdentity is true only for empty sourceOrderId", () => {
  assert.equal(isMalformedIdentity(row({ sourceOrderId: "" })), true);
  assert.equal(isMalformedIdentity(row({ sourceOrderId: "X" })), false);
});

test("visibleSignals surfaces flagged and unknown, hides clear", () => {
  const r = row({
    signals: [sig("unmatched", "flagged"), sig("blocked", "unknown"), sig("manual_review", "clear")],
  });
  const out = visibleSignals(r);
  assert.deepEqual(out.map((s) => `${s.kind}:${s.state}`), ["unmatched:flagged", "blocked:unknown"]);
});

// ── labels ───────────────────────────────────────────────────────────────────

test("source/channel/status/signal labels map to fixed Arabic", () => {
  assert.equal(getSourceLabel("talabat"), "Talabat");
  assert.equal(getSourceLabel("shopify"), "Shopify");
  assert.equal(getChannelLabel("unknown"), "قناة غير محددة");
  assert.equal(getStatusLabel("manual_review"), "مراجعة يدوية");
  assert.equal(getSignalKindLabel("unmatched"), "صنف غير مطابق");
  assert.equal(getSignalStateLabel("flagged"), "مرصود");
  assert.equal(getSignalStateLabel("unknown"), "غير محسوم"); // unknown state is NOT treated as sound
});

test("reason: known → Arabic, unknown → generic (never reflected), null → null", () => {
  assert.equal(getReasonLabel("insufficient_stock"), "مخزون غير كافٍ");
  assert.equal(getReasonLabel("totally_made_up_code_1234"), "سبب غير معروف");
  assert.ok(!getReasonLabel("totally_made_up_code_1234")!.includes("totally"), "unknown text not reflected");
  assert.equal(getReasonLabel(null), null);
});

// ── Prototype-safe label lookup (inherited keys fail closed) ─────────────────

test("getReasonLabel: inherited Object keys fall closed to the generic reason label", () => {
  for (const key of ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"]) {
    const out = getReasonLabel(key);
    assert.equal(out, "سبب غير معروف", `reason key ${key}`);
    assert.equal(typeof out, "string", `reason key ${key} returns a string, never a function/object`);
  }
});

test("getReasonLabel: known code still maps, unknown text is never reflected", () => {
  assert.equal(getReasonLabel("insufficient_stock"), "مخزون غير كافٍ");
  const hostile = getReasonLabel("constructor");
  assert.ok(!hostile!.includes("constructor"), "inherited key text not reflected");
});

test("label getters: runtime-invalid / prototype keys → fixed generic label", () => {
  // Casts ONLY to simulate runtime-invalid inputs the TS contract forbids.
  assert.equal(getSourceLabel("__proto__" as unknown as OrderOpsRow["source"]), "غير معروف");
  assert.equal(getChannelLabel("constructor" as unknown as OrderOpsRow["channel"]), "غير معروف");
  assert.equal(getStatusLabel("toString" as unknown as OrderOpsStatus), "غير معروف");
  assert.equal(getSignalKindLabel("valueOf" as unknown as SignalKind), "غير معروف");
  assert.equal(getSignalStateLabel("hasOwnProperty" as unknown as ReconciliationSignal["state"]), "غير معروف");
  // known values still map correctly (no regression)
  assert.equal(getSourceLabel("shopify"), "Shopify");
  assert.equal(getSignalStateLabel("clear"), "سليم");
});

// ── Identity fields are read without value coercion ──────────────────────────

test("filter: displayOrderCode with a throwing toString is never coerced and never matches", () => {
  const hostile = {
    toString() {
      throw new Error("toString must never be called");
    },
  } as unknown as string;
  const rows = [row({ displayOrderCode: hostile, sourceOrderId: "plain-id" })];
  let out: OrderOpsRow[] = [];
  assert.doesNotThrow(() => {
    out = filterOrderOpsRows(rows, { ...DEFAULT_FILTERS, query: "anything" });
  }, "filter does not throw on a hostile displayOrderCode");
  assert.equal(out.length, 0, "hostile value never matches a query through coercion");
});

test("filter: sourceOrderId with a throwing Symbol.toPrimitive is never invoked and never matches", () => {
  const hostile = {
    [Symbol.toPrimitive]() {
      throw new Error("Symbol.toPrimitive must never be called");
    },
  } as unknown as string;
  const rows = [row({ sourceOrderId: hostile, displayOrderCode: "no-match-code" })];
  let out: OrderOpsRow[] = [];
  assert.doesNotThrow(() => {
    out = filterOrderOpsRows(rows, { ...DEFAULT_FILTERS, query: "anything" });
  }, "filter does not throw on a hostile sourceOrderId");
  assert.equal(out.length, 0, "coercion hook never runs, so no match");
});

test("filter: a hostile identity field does not break matching of other valid rows", () => {
  const hostile = {
    toString() {
      throw new Error("nope");
    },
  } as unknown as string;
  const rows = [
    row({ sourceOrderId: hostile, displayOrderCode: "bad" }),
    row({ sourceOrderId: "GOOD-1", displayOrderCode: "TAL-55" }),
  ];
  const out = filterOrderOpsRows(rows, { ...DEFAULT_FILTERS, query: "tal-55" });
  assert.deepEqual(out.map((r) => r.displayOrderCode), ["TAL-55"], "normal search still works");
});

// ── formatOrderOpsDate ───────────────────────────────────────────────────────

test("valid date string formats to a non-dash string", () => {
  const out = formatOrderOpsDate("2024-01-15T10:30:00Z");
  assert.equal(typeof out, "string");
  assert.notEqual(out, "—");
  assert.ok(out.length > 0);
});

test("invalid / non-string / null date → dash, never throws", () => {
  assert.equal(formatOrderOpsDate("not-a-date"), "—");
  assert.equal(formatOrderOpsDate(null), "—");
  assert.equal(formatOrderOpsDate(123 as unknown as string), "—");
  assert.equal(formatOrderOpsDate({} as unknown as string), "—");
});

// ── option lists ─────────────────────────────────────────────────────────────

test("option lists all start with an 'all' choice", () => {
  for (const list of [SOURCE_OPTIONS, CHANNEL_OPTIONS, STATUS_OPTIONS, ATTENTION_OPTIONS]) {
    assert.equal(list[0]!.value, "all");
  }
});

// ── Source safety scan: view file ────────────────────────────────────────────

test("view source (comments stripped) is DB-free / framework-free / any-free", () => {
  const raw = readFileSync(new URL("./order-ops-view.ts", import.meta.url), "utf8");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(!/\bfetch\s*\(/.test(src), "no fetch(");
  assert.ok(!/\.rpc\s*\(/.test(src), "no .rpc(");
  assert.ok(!/\.insert\s*\(/.test(src), "no .insert(");
  assert.ok(!/\.update\s*\(/.test(src), "no .update(");
  assert.ok(!/\.upsert\s*\(/.test(src), "no .upsert(");
  assert.ok(!/\.delete\s*\(/.test(src), "no .delete(");
  assert.ok(!/server-only/.test(src), "no server-only import");
  assert.ok(!/supabase/i.test(src), "no supabase reference");
  assert.ok(!/from\s+["']next/.test(src), "no next import");
  assert.ok(!/from\s+["']@\//.test(src), "no @/ imports (types-only sibling import)");
  assert.ok(!/Date\.now/.test(src), "no Date.now()");
  assert.ok(!/new Date\(\s*\)/.test(src), "no argless new Date()");
  // no `any` type usage
  assert.ok(!/:\s*any\b/.test(src), "no : any");
  assert.ok(!/\bas\s+any\b/.test(src), "no as any");
  assert.ok(!/<any>/.test(src), "no <any>");
  assert.ok(!/\bany\[\]/.test(src), "no any[]");
  // No value-coercion of identity/label inputs in executable code:
  // `\bString\s*\(` avoids false-matching `toLocaleString(`.
  assert.ok(!/\bString\s*\(/.test(src), "no String() coercion");
  assert.ok(!/\.toString\s*\(/.test(src), "no .toString() coercion");
  assert.ok(!/toPrimitive/.test(src), "no Symbol.toPrimitive usage");
  // No direct fixed-label bracket lookup (which would bypass own-key protection);
  // every lookup must go through the prototype-safe fixedLabel() helper.
  assert.ok(!/[A-Z][A-Z_]*_LABELS\s*\[/.test(src), "no direct *_LABELS[...] lookup");
  assert.ok(/Object\.hasOwn\s*\(/.test(src), "fixed-label lookup uses Object.hasOwn own-key guard");
});

// ── Source safety scan + wiring assertions: page file ────────────────────────

test("page source (comments stripped) is read-only, PII-safe, and correctly wired", () => {
  const raw = readFileSync(new URL("../../app/(app)/order-operations/page.tsx", import.meta.url), "utf8");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  // No writes / RPC / external calls / admin / secrets / raw dumps / logging.
  assert.ok(!/\bfetch\s*\(/.test(src), "no fetch(");
  assert.ok(!/\.rpc\s*\(/.test(src), "no .rpc(");
  assert.ok(!/\.insert\s*\(/.test(src), "no .insert(");
  assert.ok(!/\.update\s*\(/.test(src), "no .update(");
  assert.ok(!/\.upsert\s*\(/.test(src), "no .upsert(");
  assert.ok(!/\.delete\s*\(/.test(src), "no .delete(");
  assert.ok(!/createAdminClient/.test(src), "no createAdminClient");
  assert.ok(!/service_role/.test(src), "no service_role");
  assert.ok(!/process\.env/.test(src), "no process.env in page");
  assert.ok(!/dangerouslySetInnerHTML/.test(src), "no dangerouslySetInnerHTML");
  assert.ok(!/JSON\.stringify\s*\(\s*result/.test(src), "no JSON.stringify(result)");
  assert.ok(!/console\./.test(src), "no console.*");

  // Must never render raw / PII columns. Patterns target data references, not
  // CSS utility classes (e.g. Tailwind's `items-center`).
  for (const forbidden of [
    /payment_gateway_names/,
    /deduction_result/,
    /\bresolution\b/,
    /\braw\b/,
    /line_?items/i,
    /\.items\b/,
    /["']items["']/,
    /\bcustomer\b/,
    /\bphone\b/,
    /\bemail\b/,
    /\baddress\b/,
    /\btoken/,
    /\bheaders\b/,
  ]) {
    assert.ok(!forbidden.test(src), `page must not reference ${forbidden}`);
  }

  // Correct wiring: createClient → adapter → data loader, force-dynamic.
  assert.ok(/export const dynamic = "force-dynamic"/.test(src), "force-dynamic");
  assert.ok(/\bcreateClient\s*\(/.test(src), "uses createClient()");
  assert.ok(/createSupabaseOrderOpsReadClient\s*\(/.test(src), "wraps with adapter");
  assert.ok(/loadOrderOpsData\s*\(/.test(src), "calls loadOrderOpsData");

  // Read-only + partial-result messaging.
  assert.ok(/قراءة فقط/.test(src), "read-only badge/text");
  assert.ok(/النتائج جزئية لأن أحد مصادر الطلبات غير متاح\./.test(src), "partial-result warning");
  assert.ok(/تعذر تحميل لوحة عمليات الطلبات\./.test(src), "constant load-error message");
  assert.ok(/صفوف مخزون محدثة/.test(src), "deductedRows labeled as updated inventory rows (not units)");
});
