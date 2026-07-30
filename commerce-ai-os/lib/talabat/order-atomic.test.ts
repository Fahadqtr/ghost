// Source-scan guarantees for the atomic RPC migration + cross-cutting rules
// (webhook/Shopify untouched, module purity). No SQL is executed and no network
// is used — the RPC is verified as text.
// Run: node --conditions=react-server --experimental-strip-types --test lib/talabat/order-atomic.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const SQL = read("supabase/talabat_order_atomic_processing.sql");
const stripSql = (s: string) => s.replace(/--.*$/gm, "");
const SQL_CODE = stripSql(SQL);

test("24: the RPC locks the order row FOR UPDATE", () => {
  assert.match(SQL_CODE, /from\s+talabat_orders\s+where\s+id\s*=\s*p_order_id\s+for\s+update/is);
});

test("24b: it locks targeted inventory / variant / shelf rows FOR UPDATE", () => {
  assert.match(SQL_CODE, /from\s+inventory\s+where\s+product_id\s*=\s*v_pid\s+for\s+update/is);
  assert.match(SQL_CODE, /from\s+product_variants\s+where\s+parent_product_id[^;]*for\s+update/is);
  assert.match(SQL_CODE, /from\s+shelf_stock[^;]*for\s+update/is);
  assert.match(SQL_CODE, /from\s+variant_shelf_stock[^;]*for\s+update/is);
});

test("25: the RPC is atomic — one function, no partial COMMIT/BEGIN/SAVEPOINT", () => {
  assert.ok(!/\bcommit\b/i.test(SQL_CODE), "no COMMIT inside the function");
  assert.ok(!/\bsavepoint\b/i.test(SQL_CODE), "no SAVEPOINT");
  assert.ok(!/\bbegin\s+transaction\b/i.test(SQL_CODE));
  // verify-then-apply (two passes) with a single failure handler → all-or-nothing.
  assert.match(SQL_CODE, /v_fail\s+is not null/i);
});

test("23/idempotent: an already processed / manual_review order does not deduct again", () => {
  assert.match(SQL_CODE, /in \('processed', 'manual_review'\)/i);
  assert.match(SQL_CODE, /idempotent/i);
});

test("26: the RPC records a stock movement in the ledger (malak_audit)", () => {
  // This project's movement ledger is malak_audit (there is no stock_movements table).
  const inserts = SQL_CODE.match(/insert into malak_audit/gi) ?? [];
  assert.ok(inserts.length >= 2, "both the product and variant paths log a movement");
  assert.match(SQL_CODE, /'stock_out'/);
});

test("27: the RPC never adds channel_stock", () => {
  assert.ok(!/channel_stock/i.test(SQL_CODE));
});

test("22-sql: inventory rollup uses SUM of variants, never max()", () => {
  assert.match(SQL_CODE, /sum\(coalesce\(stock_quantity/i);
  assert.ok(!/\bmax\(/i.test(SQL_CODE), "must not use max() for the rollup");
});

test("19-sql: deductions are floored at zero (greatest(..., 0))", () => {
  assert.match(SQL_CODE, /greatest\(/i);
  assert.ok(!/stock_quantity\s*=\s*stock_quantity\s*-/i.test(SQL_CODE) || /greatest/i.test(SQL_CODE));
});

test("28: RPC is SECURITY DEFINER, pinned search_path, and not callable by anon/authenticated", () => {
  assert.match(SQL_CODE, /security definer/i);
  assert.match(SQL_CODE, /set search_path = public/i);
  assert.match(SQL_CODE, /revoke all on function[^;]*from public/i);
  assert.match(SQL_CODE, /revoke all on function[^;]*from anon/i);
  assert.match(SQL_CODE, /revoke all on function[^;]*from authenticated/i);
  assert.match(SQL_CODE, /grant execute on function[^;]*to service_role/i);
});

test("28b: the RPC uses no dynamic SQL", () => {
  assert.ok(!/execute\s+format/i.test(SQL_CODE), "no EXECUTE format(...)");
  assert.ok(!/execute\s+'/i.test(SQL_CODE), "no EXECUTE '<string>'");
});

test("29: only classified reasons go into resolution — no raw DB error", () => {
  assert.ok(!/sqlerrm/i.test(SQL_CODE), "SQLERRM must never be stored");
  assert.match(SQL_CODE, /jsonb_build_object\('reason', v_fail\)/);
});

test("25b: the migration is idempotent (create or replace)", () => {
  assert.match(SQL_CODE, /create or replace function public\.process_talabat_order_deduction/i);
});

test("31: the Talabat webhook is unchanged (does not import the new resolution code)", () => {
  const wh = read("app/api/webhooks/talabat/[token]/route.ts");
  assert.ok(!/order-resolver|deduction-plan|order-lines|process_talabat_order_deduction/.test(wh), "webhook must not wire the new modules this round");
  assert.match(wh, /talabat_orders/); // still just stores the order
});

test("32: the Shopify deduction workflow is unchanged", () => {
  const shop = read("lib/shopify/order-deduct-compute.ts");
  assert.match(shop, /planOrderDeductions/);
  assert.ok(!/talabat/i.test(shop), "Shopify module must not reference Talabat");
});

test("30: the new modules are pure — no Supabase / network / server-only", () => {
  for (const rel of ["lib/talabat/order-lines.ts", "lib/talabat/order-resolver.ts", "lib/talabat/deduction-plan.ts"]) {
    const src = read(rel).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!/supabase/i.test(src), `${rel} must not reference supabase`);
    assert.ok(!/\bfetch\(/.test(src), `${rel} must not call fetch`);
    assert.ok(!/from ["']server-only["']/.test(src), `${rel} must not import server-only`);
    assert.ok(!/https?:\/\//.test(src), `${rel} must not contain a network URL`);
  }
});
