// INV.4C — source guard for the atomic shelf-operations migration.
//
// Statically verifies the four shelf RPCs uphold the INV.3C/4A/4B safety contract:
// SECURITY DEFINER + search_path, service-role-only grants, deterministic FOR UPDATE
// locking, PASS-2 rowcount + subtransaction, fail-closed reasons, the deterministic
// primary-location rule, explicit-untrack semantics, and NO availability / sold /
// products mirror / stock-task / ledger writes in SQL.
//
// PURE — source scan only. Run:
// node --conditions=react-server --experimental-strip-types --test lib/inventory/inv-4c-rpc-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIG_DIR = join(ROOT, "supabase", "migrations");
const migFile = readdirSync(MIG_DIR).find((f) => /inv_4c_atomic_shelf_operations\.sql$/.test(f));
const RAW = migFile ? readFileSync(join(MIG_DIR, migFile), "utf8") : "";

function sql(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}
const CODE = sql(RAW);
const lc = CODE.toLowerCase();

const FNS = ["inv_place_shelf", "inv_replace_shelf_distribution", "inv_assign_full_shelf", "inv_move_shelf"];

test("migration exists under supabase/migrations", () => {
  assert.ok(migFile, "inv_4c_atomic_shelf_operations.sql present");
  assert.ok(RAW.length > 0, "non-empty");
});

test("defines the four INV.4C shelf functions (create or replace)", () => {
  for (const fn of FNS) {
    assert.ok(new RegExp(`create or replace function public\\.${fn}\\(`, "i").test(CODE), `${fn} create-or-replace`);
  }
});

test("every function is SECURITY DEFINER with a pinned search_path", () => {
  assert.equal((lc.match(/security definer/g) ?? []).length, 4, "4 security definer");
  assert.equal((lc.match(/set search_path = public/g) ?? []).length, 4, "4 pinned search_paths");
});

test("service-role-only grants for all four", () => {
  for (const fn of FNS) {
    for (const role of ["public", "anon", "authenticated"]) {
      assert.ok(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from ${role}`, "i").test(CODE), `${fn} revokes ${role}`);
    }
    assert.ok(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role`, "i").test(CODE), `${fn} grants service_role`);
  }
});

test("upgraded inv_place_shelf returns authoritative BEFORE fields + primaryLocation", () => {
  assert.ok(/'stockBefore'/.test(CODE), "product stockBefore returned");
  assert.ok(/'primaryLocation'/.test(CODE), "primaryLocation returned");
  assert.ok(/'variantBefore'/.test(CODE) && /'parentBefore'/.test(CODE), "variant/parent before returned");
});

test("deterministic locking: siblings (sku,id) + rows/parent FOR UPDATE", () => {
  assert.ok(/order by sku, id for update/i.test(CODE), "sibling lock ordered by (sku, id)");
  assert.ok((lc.match(/for update/g) ?? []).length >= 8, "multiple FOR UPDATE locks across the four functions");
});

test("primary location is deterministic (max quantity, tie-break location ASC)", () => {
  assert.ok(/order by quantity desc, location asc\s+limit 1/i.test(CODE), "primary = largest placement, ties by location ASC");
});

test("explicit UNTRACK preserves stock (empty distribution / empty location)", () => {
  assert.ok(/'untracked'/.test(CODE), "untracked flag returned");
  // untrack path assigns the preserved BEFORE value, not zero.
  assert.ok(/v_newstock\s*:=\s*v_stockbefore/i.test(CODE), "product untrack preserves stockBefore");
});

test("PASS-2 apply is guarded: rowcount checks + subtransaction rollback", () => {
  assert.ok((lc.match(/get diagnostics/g) ?? []).length >= 4, "rowcount captured on writes");
  assert.ok((CODE.match(/<>\s*1\s*then\s*raise exception/gi) ?? []).length >= 4, "ROW_COUNT = 1 assertions");
  assert.ok((lc.match(/exception when others then/g) ?? []).length >= 4, "each function has an apply subtransaction");
  assert.ok(/apply_failed/.test(CODE), "classified apply failure");
});

test("fail-closed validation + scope + shelf + overflow guards present", () => {
  for (const reason of [
    "inventory_inconsistent", "product_has_variants", "parent_has_shelf_rows",
    "placement_not_found", "invalid_rows", "invalid_location", "invalid_quantity",
    "same_location", "overflow", "missing_variant",
  ]) {
    assert.ok(new RegExp(reason).test(CODE), `reason ${reason} present`);
  }
  assert.ok(/is null or\s+quantity\s*<\s*0/i.test(CODE) || /is null or stock_quantity < 0/i.test(CODE), "null/negative rejected, not coalesced");
});

test("rollup uses Σ (never products.stock_quantity, never max)", () => {
  assert.ok(/coalesce\(sum\(stock_quantity\),\s*0\)/i.test(CODE), "parent rollup sums variants");
  assert.ok(/coalesce\(sum\(quantity\),\s*0\)/i.test(CODE), "stock = Σ shelves");
  assert.equal(/max\(/i.test(CODE), false, "no max() anywhere");
});

test("authoritative writers: shelf overlays + numeric stock only", () => {
  assert.ok(/update inventory set stock_quantity/i.test(CODE), "writes inventory.stock_quantity");
  assert.ok(/update product_variants set stock_quantity/i.test(CODE), "writes variant stock");
  assert.ok(/into shelf_stock|delete from shelf_stock/i.test(CODE), "product shelf writes");
  assert.ok(/into variant_shelf_stock|delete from variant_shelf_stock/i.test(CODE), "variant shelf writes");
  assert.ok(/set stock_quantity = [^,]+, location = /i.test(CODE), "product syncs inventory.location = primary");
});

test("NO availability / sold / products mirror / task / ledger writes in SQL", () => {
  assert.equal(/stock_status/i.test(CODE), false, "never touches stock_status (availability boundary)");
  assert.equal(/availability/i.test(CODE), false, "no availability reference");
  assert.equal(/sold_quantity/i.test(CODE), false, "shelf ops never touch sold_quantity");
  assert.equal(/update\s+products\b/i.test(CODE), false, "never writes the products table");
  assert.equal(/products\.stock_quantity/i.test(CODE), false, "never uses the products.stock_quantity mirror");
  assert.equal(/malak_audit/i.test(CODE), false, "no ledger row inside SQL");
  assert.equal(/staff_tasks/i.test(CODE), false, "no stock task inside SQL");
  assert.equal(/shelf_slots/i.test(CODE), false, "shelf topology (shelf_slots) is not touched by the quantity RPCs");
});