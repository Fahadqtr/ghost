// INV.4B — source guard for the inv_adjust_variant_movement migration.
//
// Statically verifies the new atomic variant-movement RPC upholds the INV.3C/4A
// safety contract PLUS the INV.4B sold_quantity contract: SECURITY DEFINER +
// search_path, service-role-only grants, deterministic FOR UPDATE locking, PASS-2
// rowcount-checked subtransaction, the fail-closed sold + shelf guards, and NO
// availability / products mirror / stock-task / ledger writes. sold_quantity IS
// written here (that is the point of the RPC), but ONLY on a sale-out.
//
// PURE — source scan only. Run:
// node --conditions=react-server --experimental-strip-types --test lib/inventory/inv-4b-rpc-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIG_DIR = join(ROOT, "supabase", "migrations");
const migFile = readdirSync(MIG_DIR).find((f) => /inv_4b_variant_movement\.sql$/.test(f));
const RAW = migFile ? readFileSync(join(MIG_DIR, migFile), "utf8") : "";

function sql(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}
const CODE = sql(RAW);
const lc = CODE.toLowerCase();

test("migration exists under supabase/migrations", () => {
  assert.ok(migFile, "inv_4b_variant_movement.sql present");
  assert.ok(RAW.length > 0, "non-empty");
});

test("defines inv_adjust_variant_movement(uuid, integer, integer), SECURITY DEFINER + search_path", () => {
  assert.ok(/create or replace function public\.inv_adjust_variant_movement\(/i.test(CODE), "create or replace");
  assert.ok(/p_variant_id\s+uuid/i.test(CODE) && /p_delta\s+integer/i.test(CODE) && /p_sold_delta\s+integer/i.test(CODE), "signature");
  assert.equal((lc.match(/security definer/g) ?? []).length, 1, "security definer");
  assert.equal((lc.match(/set search_path = public/g) ?? []).length, 1, "pinned search_path");
});

test("the legacy inv_adjust_variant signature is NOT redefined here", () => {
  assert.equal(/create or replace function public\.inv_adjust_variant\s*\(/i.test(CODE), false, "does not touch the old adjust RPC");
});

test("service-role-only grants (uuid, integer, integer)", () => {
  for (const role of ["public", "anon", "authenticated"]) {
    assert.ok(new RegExp(`revoke all on function public\\.inv_adjust_variant_movement\\([^)]*\\) from ${role}`, "i").test(CODE), `revoke ${role}`);
  }
  assert.ok(/grant execute on function public\.inv_adjust_variant_movement\([^)]*\) to service_role/i.test(CODE), "grant service_role");
});

test("sold contract enforced in PASS-1 (0, or sale-out with sold = abs(delta))", () => {
  assert.ok(/invalid_sold_delta/.test(CODE), "negative/NULL sold rejected");
  assert.ok(/sold_delta_mismatch/.test(CODE), "sold on IN, or sold ≠ |delta| out, rejected");
  assert.ok(/p_delta\s*<\s*0\s+and\s+p_sold_delta\s*=\s*abs\(p_delta\)/i.test(CODE), "sale-out requires sold = abs(delta)");
});

test("sold is fail-closed read + overflow-guarded ONLY when it increments", () => {
  assert.ok(/if p_sold_delta\s*>\s*0 then/i.test(CODE), "sold branch is gated on sold_delta > 0");
  assert.ok(/sold_inconsistent/.test(CODE), "NULL/negative sold rejected on a sale");
  // the sold column is written, but inside the sale branch only.
  assert.ok(/sold_quantity\s*=\s*v_sold_after/i.test(CODE), "sold_quantity incremented on a sale-out");
});

test("deterministic locking: siblings FOR UPDATE (sku, id), then parent inventory", () => {
  assert.ok(/order by sku, id for update/i.test(CODE), "sibling lock ordered by (sku, id)");
  assert.ok(/from inventory where product_id = v_pid for update/i.test(CODE), "parent inventory row locked");
  assert.ok((lc.match(/for update/g) ?? []).length >= 2, "sibling + parent locks present");
});

test("authoritative parentBefore = Σ variants BEFORE; parentStock = Σ variants AFTER", () => {
  assert.ok(/coalesce\(sum\(stock_quantity\),\s*0\)\s+into v_parentbefore/i.test(CODE), "parentBefore is Σ variants (pre-mutation)");
  assert.ok(/coalesce\(sum\(stock_quantity\),\s*0\)\s+into v_sum/i.test(CODE), "parentStock is Σ variants (post-mutation)");
  assert.ok(/'parentBefore'/.test(CODE) && /'parentStock'/.test(CODE), "both returned");
  assert.ok(/'soldBefore'/.test(CODE) && /'soldAfter'/.test(CODE), "sold before/after returned");
  assert.equal(/max\(/i.test(CODE), false, "no max(parent, variants) anywhere");
});

test("fail-closed + no-negative + overflow + shelf guards present", () => {
  assert.ok(/inventory_inconsistent/.test(CODE), "malformed rollup → inventory_inconsistent");
  assert.ok(/insufficient_stock/.test(CODE), "below-zero result rejected");
  assert.ok(/overflow/.test(CODE), "int4 overflow guarded");
  assert.ok(/is null or stock_quantity < 0/i.test(CODE), "null/negative sibling rejected, not coalesced");
  assert.ok(/variant_has_shelf_rows/.test(CODE), "shelf-tracked variant rejected");
  assert.ok(/parent_has_shelf_rows/.test(CODE), "variant rollup vs product shelf rejected");
});

test("PASS-2 apply is guarded: rowcount checks + subtransaction rollback", () => {
  assert.ok((lc.match(/get diagnostics/g) ?? []).length >= 2, "rowcount captured on writes");
  assert.ok((CODE.match(/<>\s*1\s*then\s*raise exception/gi) ?? []).length >= 2, "each write asserts ROW_COUNT = 1");
  assert.ok(/exception when others then/i.test(CODE), "apply subtransaction");
  assert.ok(/apply_failed/.test(CODE), "classified apply failure");
});

test("authoritative writers: variant stock + parent rollup (+ sale sold) only", () => {
  assert.ok(/update product_variants set stock_quantity = v_after/i.test(CODE), "writes product_variants.stock_quantity");
  assert.ok(/update inventory set stock_quantity = v_sum::int/i.test(CODE), "writes inventory rollup");
});

test("NO availability / products mirror / task / ledger writes in SQL", () => {
  assert.equal(/stock_status/i.test(CODE), false, "never touches stock_status (availability boundary)");
  assert.equal(/availability/i.test(CODE), false, "no availability reference");
  assert.equal(/update\s+products\b/i.test(CODE), false, "never writes the products table");
  assert.equal(/products\.stock_quantity/i.test(CODE), false, "never uses the products.stock_quantity mirror");
  assert.equal(/malak_audit/i.test(CODE), false, "no ledger row written inside SQL (caller owns audit)");
  assert.equal(/staff_tasks/i.test(CODE), false, "no stock task opened inside SQL (caller owns transitions)");
  // shelf tables are READ in PASS-1 guards (select 1 from …) but never WRITTEN.
  assert.equal(/(update\s+(shelf_stock|variant_shelf_stock)\b|insert\s+into\s+(shelf_stock|variant_shelf_stock)\b|delete\s+from\s+(shelf_stock|variant_shelf_stock)\b)/i.test(CODE), false, "no shelf table write (guard reads only)");
});
