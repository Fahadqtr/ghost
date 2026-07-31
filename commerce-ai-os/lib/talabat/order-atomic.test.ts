// Source-scan guarantees for the atomic RPC migration + cross-cutting rules
// (webhook/Shopify untouched, module purity, malak_audit contract). No SQL is
// executed and no network is used — the RPC is verified as text.
// Run: node --conditions=react-server --experimental-strip-types --test lib/talabat/order-atomic.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const SQL = read("supabase/talabat_order_atomic_processing.sql");
const SQL_CODE = SQL.replace(/--.*$/gm, "");

test("24: locks the order row FOR UPDATE", () => {
  assert.match(SQL_CODE, /from\s+talabat_orders\s+where\s+id\s*=\s*p_order_id\s+for\s+update/is);
});

test("24b: locks targeted inventory / variant / shelf rows FOR UPDATE", () => {
  assert.match(SQL_CODE, /from\s+inventory\s+where\s+product_id\s*=\s*v_pid\s+for\s+update/is);
  assert.match(SQL_CODE, /from\s+product_variants\s+where\s+parent_product_id[^;]*for\s+update/is);
  assert.match(SQL_CODE, /from\s+shelf_stock[^;]*for\s+update/is);
  assert.match(SQL_CODE, /from\s+variant_shelf_stock[^;]*for\s+update/is);
});

test("25: atomic — one function, no partial COMMIT/BEGIN-TX/SAVEPOINT; verify-then-apply", () => {
  assert.ok(!/\bcommit\b/i.test(SQL_CODE));
  assert.ok(!/\bsavepoint\b/i.test(SQL_CODE));
  assert.ok(!/\bbegin\s+transaction\b/i.test(SQL_CODE));
  assert.match(SQL_CODE, /v_fail\s+is not null/i);
  assert.match(SQL_CODE, /create or replace function public\.process_talabat_order_deduction/i);
});

test("8: a per-dedup-key advisory lock is taken before any inventory lock", () => {
  assert.match(SQL_CODE, /pg_advisory_xact_lock\(hashtext\(p_dedup_key\)\)/i);
  const advIdx = SQL_CODE.search(/pg_advisory_xact_lock/i);
  const invIdx = SQL_CODE.search(/from\s+inventory\s+where\s+product_id\s*=\s*v_pid\s+for\s+update/is);
  assert.ok(advIdx >= 0 && invIdx >= 0 && advIdx < invIdx, "advisory lock precedes inventory lock");
  assert.match(SQL_CODE, /missing_dedup_key/); // non-empty dedup key mandatory
});

test("8b: a duplicate dedup key across orders blocks deduction (not via unique-index failure)", () => {
  assert.match(SQL_CODE, /dedup_key\s*=\s*p_dedup_key\s+and\s+id\s*<>\s*p_order_id\s+and\s+processing_status\s*=\s*'processed'/is);
  assert.match(SQL_CODE, /'duplicate_order'/);
});

test("4: invalid / empty plan is rejected (invalid_plan, no deduction)", () => {
  assert.match(SQL_CODE, /jsonb_typeof\(p_plan -> 'deductions'\) <> 'array'/);
  assert.match(SQL_CODE, /jsonb_array_length\(p_plan -> 'deductions'\) = 0/);
  assert.match(SQL_CODE, /'invalid_plan'/);
  assert.match(SQL_CODE, /!~ '\^\[1-9\]\[0-9\]\*\$'/); // quantity must be a positive integer string
});

test("6: the plan is aggregated by (product, variant) before pass 1/2", () => {
  assert.match(SQL_CODE, /jsonb_agg/i);
  assert.match(SQL_CODE, /group by 1, 2/i);
});

test("6b: each UPDATE checks the affected row count (rollback on mismatch)", () => {
  assert.match(SQL_CODE, /get diagnostics\s+v_rows\s*=\s*row_count/i);
  assert.match(SQL_CODE, /v_rows\s*<>\s*1/);
});

test("7: RPC inventory invariants (exactly one variant / one inventory; no variants for no-variant target)", () => {
  assert.match(SQL_CODE, /count\(\*\)[^;]*from product_variants where parent_product_id = v_pid and sku = v_vsku/is);
  assert.match(SQL_CODE, /count\(\*\)[^;]*from inventory where product_id = v_pid/is);
  assert.match(SQL_CODE, /count\(\*\)[^;]*from product_variants where parent_product_id = v_pid;/is);
  assert.match(SQL_CODE, /v_cnt <> 1/);
  assert.match(SQL_CODE, /v_cnt <> 0/);
});

test("19: underflow is a verified RAISE, not hidden by greatest()", () => {
  assert.ok(!/greatest\(/i.test(SQL_CODE), "must not use greatest() to hide an underflow");
  assert.match(SQL_CODE, /if v_after < 0 then raise exception/i);
});

test("22: rollup uses SUM of variants, never max()", () => {
  assert.match(SQL_CODE, /sum\(coalesce\(stock_quantity/i);
  assert.ok(!/\bmax\(/i.test(SQL_CODE));
});

test("26: records a stock movement in the ledger (malak_audit), never a stock_movements table", () => {
  assert.ok((SQL_CODE.match(/insert into malak_audit/gi) ?? []).length >= 2);
  assert.match(SQL_CODE, /'stock_out'/);
});

test("27: never adds channel_stock", () => {
  assert.ok(!/channel_stock/i.test(SQL_CODE));
});

test("28: SECURITY DEFINER, pinned search_path, not callable by anon/authenticated, no dynamic SQL", () => {
  assert.match(SQL_CODE, /security definer/i);
  assert.match(SQL_CODE, /set search_path = public/i);
  assert.match(SQL_CODE, /revoke all on function[^;]*from public/i);
  assert.match(SQL_CODE, /revoke all on function[^;]*from anon/i);
  assert.match(SQL_CODE, /revoke all on function[^;]*from authenticated/i);
  assert.match(SQL_CODE, /grant execute on function[^;]*to service_role/i);
  assert.ok(!/execute\s+format/i.test(SQL_CODE) && !/execute\s+'/i.test(SQL_CODE));
});

test("9: resolution is whitelisted — p_resolution is never stored raw, no SQLERRM", () => {
  assert.match(SQL_CODE, /v_safe := jsonb_strip_nulls\(jsonb_build_object/);
  assert.ok(!/resolution\s*=\s*p_resolution\b/.test(SQL_CODE), "must not store p_resolution raw");
  assert.ok(!/resolution\s*=\s*coalesce\(p_resolution/.test(SQL_CODE));
  assert.ok(!/sqlerrm/i.test(SQL_CODE));
});

test("10: the audit insert matches the real malak_audit schema", () => {
  const schema = read("supabase/malak_audit.sql");
  // columns declared by the table
  const tableCols = new Set(
    [...schema.matchAll(/^\s*(id|created_at|action_type|agent|sku|product_id|field|old_value|new_value|details|status)\b/gim)].map((m) => m[1].toLowerCase()),
  );
  for (const c of ["action_type", "agent", "sku", "product_id", "field", "old_value", "new_value", "details", "status"]) {
    assert.ok(tableCols.has(c), `malak_audit must declare ${c}`);
  }
  // every column the RPC inserts must exist in the table
  const m = SQL_CODE.match(/insert into malak_audit \(([^)]*)\)/i);
  assert.ok(m, "RPC inserts into malak_audit");
  for (const col of m![1].split(",").map((s) => s.trim().toLowerCase())) {
    assert.ok(tableCols.has(col), `inserted column ${col} not in malak_audit`);
  }
  // the values used (action_type 'stock_out', status 'done') match the existing ledger writer
  const mv = read("lib/inventory/movements.ts");
  assert.match(mv, /"stock_out"/);
  assert.match(mv, /status:\s*"done"/);
});

test("31: the Talabat webhook is unchanged (does not import the new resolution code)", () => {
  const wh = read("app/api/webhooks/talabat/[token]/route.ts");
  assert.ok(!/order-resolver|deduction-plan|order-lines|process_talabat_order_deduction/.test(wh));
  assert.match(wh, /talabat_orders/);
});

test("32: the Shopify deduction workflow is unchanged", () => {
  const shop = read("lib/shopify/order-deduct-compute.ts");
  assert.match(shop, /planOrderDeductions/);
  assert.ok(!/talabat/i.test(shop));
});

test("30: the new modules are pure — no Supabase / network / server-only", () => {
  for (const rel of ["lib/talabat/order-resolver.ts", "lib/talabat/deduction-plan.ts"]) {
    const src = read(rel).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!/supabase/i.test(src) && !/\bfetch\(/.test(src) && !/from ["']server-only["']/.test(src) && !/https?:\/\//.test(src), `${rel} impure`);
  }
  // order-lines uses node:crypto (SHA-256) — allowed — but never network/supabase.
  const ol = read("lib/talabat/order-lines.ts").replace(/\/\/.*$/gm, "");
  assert.ok(!/supabase/i.test(ol) && !/\bfetch\(/.test(ol) && !/https?:\/\//.test(ol));
});
