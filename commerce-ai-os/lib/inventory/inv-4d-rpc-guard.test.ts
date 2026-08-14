// INV.4D — source guard for the hardened sync_product_variants migration.
//
// Verifies the CREATE OR REPLACE keeps the existing security/identity contract AND
// adds the INV.4D hardening: fail-closed quantities, shelf-managed protection, the
// parent/variant shelf conflict, deterministic locking, the atomic parent rollup,
// and the richer return — with NO products mirror / availability / sold write in SQL.
//
// PURE — source scan only. Run:
// node --conditions=react-server --experimental-strip-types --test lib/inventory/inv-4d-rpc-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIG_DIR = join(ROOT, "supabase", "migrations");
const migFile = readdirSync(MIG_DIR).find((f) => /inv_4d_editor_variant_rollup\.sql$/.test(f));
const RAW = migFile ? readFileSync(join(MIG_DIR, migFile), "utf8") : "";
const CODE = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

test("migration exists", () => {
  assert.ok(migFile, "inv_4d_editor_variant_rollup.sql present");
  assert.ok(RAW.length > 0, "non-empty");
});

test("CREATE OR REPLACE of sync_product_variants(uuid, jsonb), same signature", () => {
  assert.ok(/create or replace function public\.sync_product_variants\(\s*p_product_id uuid,\s*p_variants\s+jsonb\s*\)/i.test(CODE),
    "same name + signature");
});

test("security model preserved: SECURITY INVOKER + pinned search_path (NOT service-role)", () => {
  assert.ok(/security invoker/i.test(CODE), "SECURITY INVOKER (RLS applies)");
  assert.ok(/set search_path = public, pg_temp/i.test(CODE), "pinned search_path");
  assert.equal(/security definer/i.test(CODE), false, "never elevates to definer");
});

test("grants preserved: revoke public/anon, GRANT authenticated (session editor keeps it)", () => {
  assert.ok(/revoke all on function public\.sync_product_variants\(uuid, jsonb\) from public/i.test(CODE));
  assert.ok(/revoke all on function public\.sync_product_variants\(uuid, jsonb\) from anon/i.test(CODE));
  assert.ok(/grant execute on function public\.sync_product_variants\(uuid, jsonb\) to authenticated/i.test(CODE));
});

test("existing identity/delete guards preserved", () => {
  for (const code of ["unknown_variant_id", "duplicate_variant_id", "variant_has_shelf_stock", "variant_has_channel_mapping"]) {
    assert.ok(new RegExp(code).test(CODE), `${code} preserved`);
  }
  assert.ok(/parent_product_id = p_product_id/i.test(CODE), "ownership re-checked at write time");
  assert.ok(/channel_variant_mappings/i.test(CODE), "channel-mapping delete guard preserved");
});

test("INV.4D fail-closed quantity + shelf-managed + parent-conflict codes", () => {
  for (const code of ["variant_invalid_quantity", "variant_stock_managed_by_shelves", "variant_parent_shelf_conflict"]) {
    assert.ok(new RegExp(code).test(CODE), `${code} present`);
  }
  // integer / non-negative / no-fractional / overflow checks on quantities
  assert.ok(/<>\s*trunc\(/i.test(CODE), "rejects fractional quantities");
  assert.ok(/>\s*2147483647/.test(CODE), "int4 overflow guarded");
  // shelf-managed retained variant: submitted must equal current, else reject
  assert.ok(/is distinct from pv\.stock_quantity/i.test(CODE), "shelf-managed variant stock change rejected");
});

test("deterministic locking of the variant set + parent inventory", () => {
  assert.ok(/order by id for update/i.test(CODE), "variants locked deterministically");
  assert.ok(/from public\.inventory where product_id = p_product_id for update/i.test(CODE), "parent inventory locked");
});

test("atomic parent rollup: inventory.stock = Σ variants, rowcount-checked, only when variants remain", () => {
  assert.ok(/v_will_have\s*:=\s*v_final_count > 0/i.test(CODE), "recomputes final grain");
  assert.ok(/if v_will_have then/i.test(CODE), "rollup only for a variant product");
  assert.ok(/update public\.inventory\s+set stock_quantity = v_parentstock/i.test(CODE), "parent = Σ variants");
  assert.ok(/get diagnostics v_rows = row_count/i.test(CODE) && /if v_rows <> 1 then/i.test(CODE), "rowcount checked");
});

test("richer return contract", () => {
  for (const k of ["'hasVariants'", "'parentBefore'", "'parentStock'", "'variantChanges'", "'status'"]) {
    assert.ok(CODE.includes(k), `returns ${k}`);
  }
  // legacy fields kept for backward compatibility
  for (const k of ["'updated'", "'inserted'", "'deleted'", "'ok', true"]) {
    assert.ok(CODE.includes(k), `keeps legacy ${k}`);
  }
});

test("rollup uses Σ (never max, never products mirror), no availability / sold in SQL", () => {
  assert.ok(/coalesce\(sum\(coalesce\(stock_quantity, 0\)\), 0\)/i.test(CODE), "parent = SUM of variants");
  assert.equal(/max\(/i.test(CODE), false, "no max()");
  assert.equal(/products\.stock_quantity|update\s+products\b|update public\.products/i.test(CODE), false, "never writes the products mirror");
  assert.equal(/stock_status/i.test(CODE), false, "no availability write");
  assert.equal(/sold_quantity/i.test(CODE), false, "no sold write");
  // shelf tables are only READ for the guards, never written by this RPC
  assert.equal(/(insert into|update|delete from)\s+public\.shelf_stock/i.test(CODE), false, "never writes product shelf_stock");
});
