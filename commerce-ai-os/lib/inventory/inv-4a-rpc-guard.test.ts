// INV.4A — source guard for the inv_set_absolute_product migration.
//
// Statically verifies the new product-grain RPC upholds the same safety contract
// as the INV.3C RPCs: SECURITY DEFINER + search_path, service-role-only grants,
// FOR UPDATE lock, rowcount-checked subtransaction, fail-closed reasons, the
// variant/shelf scope guards, and NO availability / sold_quantity / products
// mirror / stock-task / ledger writes.
//
// PURE — source scan only. Run:
// node --conditions=react-server --experimental-strip-types --test lib/inventory/inv-4a-rpc-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIG_DIR = join(ROOT, "supabase", "migrations");
const migFile = readdirSync(MIG_DIR).find((f) => /inv_4a_set_absolute_product\.sql$/.test(f));
const RAW = migFile ? readFileSync(join(MIG_DIR, migFile), "utf8") : "";

function sql(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}
const CODE = sql(RAW);
const lc = CODE.toLowerCase();

test("migration exists under supabase/migrations", () => {
  assert.ok(migFile, "inv_4a_set_absolute_product.sql present");
  assert.ok(RAW.length > 0, "non-empty");
});

test("defines inv_set_absolute_product(uuid, integer), SECURITY DEFINER + search_path", () => {
  assert.ok(/create or replace function public\.inv_set_absolute_product\(/i.test(CODE), "create or replace");
  assert.ok(/p_inventory_id\s+uuid/i.test(CODE) && /p_quantity\s+integer/i.test(CODE), "signature");
  assert.equal((lc.match(/security definer/g) ?? []).length, 1, "security definer");
  assert.equal((lc.match(/set search_path = public/g) ?? []).length, 1, "pinned search_path");
});

test("service-role-only grants", () => {
  for (const role of ["public", "anon", "authenticated"]) {
    assert.ok(new RegExp(`revoke all on function public\\.inv_set_absolute_product\\([^)]*\\) from ${role}`, "i").test(CODE), `revoke ${role}`);
  }
  assert.ok(/grant execute on function public\.inv_set_absolute_product\([^)]*\) to service_role/i.test(CODE), "grant service_role");
});

test("PASS-1 locks, fail-closed, and guards variants + shelves", () => {
  assert.ok(/for update/i.test(CODE), "locks the inventory row FOR UPDATE");
  assert.ok(/is null or\s+v_before\s*<\s*0/i.test(CODE), "current stock null/negative rejected (fail-closed)");
  assert.ok(/product_has_variants/.test(CODE), "variant product rejected");
  assert.ok(/product_has_shelf_rows/.test(CODE), "shelf-tracked product rejected");
  assert.ok(/invalid_quantity/.test(CODE) && /missing_inventory/.test(CODE) && /overflow/.test(CODE), "arg + overflow guards");
});

test("PASS-2 is a single rowcount-checked UPDATE in a subtransaction", () => {
  assert.ok(/exception when others then/i.test(CODE), "apply subtransaction");
  assert.ok(/apply_failed/.test(CODE), "classified apply failure");
  assert.ok(/get diagnostics/i.test(CODE) && /<>\s*1\s*then\s*raise exception/i.test(CODE), "ROW_COUNT = 1 assertion");
  assert.ok(/update inventory set stock_quantity = p_quantity, updated_at = now\(\)/i.test(CODE), "writes stock_quantity + updated_at");
});

test("NO availability / sold_quantity / products mirror / task / ledger writes", () => {
  assert.equal(/stock_status/i.test(CODE), false, "no stock_status");
  assert.equal(/availability/i.test(CODE), false, "no availability");
  assert.equal(/sold_quantity/i.test(CODE), false, "no sold_quantity");
  assert.equal(/update\s+products\b/i.test(CODE), false, "no products write");
  assert.equal(/products\.stock_quantity/i.test(CODE), false, "no products mirror");
  assert.equal(/malak_audit/i.test(CODE), false, "no ledger in SQL");
  assert.equal(/staff_tasks/i.test(CODE), false, "no stock task in SQL");
  // never WRITES variant or shelf tables (product-grain only). Reading them in a
  // PASS-1 guard (`from ... where exists`) is expected and allowed.
  assert.equal(/(update\s+product_variants\b|insert\s+into\s+product_variants\b|delete\s+from\s+product_variants\b)/i.test(CODE), false, "no variant write");
  assert.equal(/(update\s+(shelf_stock|variant_shelf_stock)\b|insert\s+into\s+(shelf_stock|variant_shelf_stock)\b|delete\s+from\s+(shelf_stock|variant_shelf_stock)\b)/i.test(CODE), false, "no shelf table write");
});
