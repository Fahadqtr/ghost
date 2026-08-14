// INV.3C — source guard for the atomic inventory RPC migration.
//
// Statically verifies the migration SQL upholds the INV.3C safety contract:
// three functions, SECURITY DEFINER + search_path, service-role-only grants,
// deterministic FOR UPDATE locking, PASS-2 rowcount checks + subtransaction,
// fail-closed reasons, and NO availability / sold_quantity / products.stock_quantity
// / stock-task / ledger writes inside the SQL.
//
// PURE — source scan only. Run:
// node --conditions=react-server --experimental-strip-types --test lib/inventory/inv-3c-rpc-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIG_DIR = join(ROOT, "supabase", "migrations");

const migFile = readdirSync(MIG_DIR).find((f) => /inv_3c_atomic_inventory_rpcs\.sql$/.test(f));
const RAW = migFile ? readFileSync(join(MIG_DIR, migFile), "utf8") : "";

// Strip /* */ and -- comments so prose that NAMES forbidden tokens (to describe
// the invariant) never trips the "must be absent" scans. Executable SQL only.
function sql(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}
const CODE = sql(RAW);
const lc = CODE.toLowerCase();

test("migration file exists under supabase/migrations", () => {
  assert.ok(migFile, "inv_3c_atomic_inventory_rpcs.sql present in supabase/migrations");
  assert.ok(RAW.length > 0, "migration is non-empty");
});

test("defines exactly the three INV.3C functions", () => {
  for (const fn of ["inv_adjust_variant", "inv_set_variant_absolute", "inv_place_shelf"]) {
    assert.ok(
      new RegExp(`create or replace function public\\.${fn}\\(`, "i").test(CODE),
      `${fn} is created with create-or-replace (idempotent)`,
    );
  }
});

test("every function is SECURITY DEFINER with a pinned search_path", () => {
  const definers = (lc.match(/security definer/g) ?? []).length;
  const paths = (lc.match(/set search_path = public/g) ?? []).length;
  assert.equal(definers, 3, "3 security definer functions");
  assert.equal(paths, 3, "3 pinned search_paths");
});

test("grants: service-role only (revoke public/anon/authenticated, grant service_role)", () => {
  for (const fn of ["inv_adjust_variant", "inv_set_variant_absolute", "inv_place_shelf"]) {
    for (const role of ["public", "anon", "authenticated"]) {
      assert.ok(
        new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from ${role}`, "i").test(CODE),
        `${fn} revokes from ${role}`,
      );
    }
    assert.ok(
      new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role`, "i").test(CODE),
      `${fn} grants execute to service_role`,
    );
  }
});

test("deterministic locking: siblings locked FOR UPDATE in (sku, id) order", () => {
  assert.ok(/order by sku, id for update/i.test(CODE), "sibling lock ordered by (sku, id)");
  // Every function that mutates locks rows FOR UPDATE (no bare JS-style RMW).
  assert.ok((lc.match(/for update/g) ?? []).length >= 3, "multiple FOR UPDATE locks present");
});

test("PASS-2 apply is guarded: rowcount checks + subtransaction rollback", () => {
  assert.ok((lc.match(/get diagnostics/g) ?? []).length >= 4, "rowcount captured on writes");
  assert.ok((CODE.match(/<>\s*1\s*then\s*raise exception/gi) ?? []).length >= 4, "each write asserts ROW_COUNT = 1");
  assert.ok((lc.match(/exception when others then/g) ?? []).length >= 3, "each function has an apply subtransaction");
  assert.ok(/apply_failed/.test(CODE), "apply failure returns a classified reason");
});

test("fail-closed validation + no-negative + overflow guards present", () => {
  assert.ok(/inventory_inconsistent/.test(CODE), "malformed state → inventory_inconsistent");
  assert.ok(/insufficient_stock/.test(CODE), "below-zero result → insufficient_stock");
  assert.ok(/overflow/.test(CODE), "int4 overflow guarded");
  assert.ok(/is null or\s+\w+\s*<\s*0/i.test(CODE) || /is null or stock_quantity < 0/i.test(CODE), "null/negative rejected, not coalesced");
  // fail-closed shelf contract decisions are explicit
  assert.ok(/variant_has_shelf_rows/.test(CODE), "shelf-tracked variant adjust is rejected");
  assert.ok(/parent_has_shelf_rows/.test(CODE), "variant rollup vs product shelf is rejected");
  assert.ok(/product_has_variants/.test(CODE), "product-shelf on a variant product is rejected");
});

test("parent rollup uses Σ variants (never products.stock_quantity, never max)", () => {
  assert.ok(/coalesce\(sum\(stock_quantity\),\s*0\)[\s\S]*product_variants/i.test(CODE), "rollup sums product_variants");
  assert.equal(/max\(/i.test(CODE), false, "no max(parent, variants) anywhere");
});

test("NO availability / sold_quantity / products.stock_quantity / task / ledger writes in SQL", () => {
  assert.equal(/stock_status/i.test(CODE), false, "never touches stock_status (availability boundary)");
  assert.equal(/availability/i.test(CODE), false, "no availability reference in executable SQL");
  assert.equal(/sold_quantity/i.test(CODE), false, "adjustments/placements never touch sold_quantity");
  assert.equal(/update\s+products\b/i.test(CODE), false, "never writes the products table");
  assert.equal(/products\.stock_quantity/i.test(CODE), false, "never uses the products.stock_quantity mirror");
  assert.equal(/malak_audit/i.test(CODE), false, "no ledger row written inside SQL (caller owns audit)");
  assert.equal(/staff_tasks/i.test(CODE), false, "no stock task opened inside SQL (caller owns transitions)");
});

test("authoritative writers are the three numeric-stock tables only", () => {
  // Mutations target product_variants / inventory / shelf_stock / variant_shelf_stock.
  assert.ok(/update product_variants set stock_quantity/i.test(CODE), "writes product_variants.stock_quantity");
  assert.ok(/update inventory set stock_quantity/i.test(CODE), "writes inventory.stock_quantity (rollup / shelf master)");
  assert.ok(/into shelf_stock|from shelf_stock/i.test(CODE), "product shelf placement");
  assert.ok(/into variant_shelf_stock|from variant_shelf_stock/i.test(CODE), "variant shelf placement");
});
