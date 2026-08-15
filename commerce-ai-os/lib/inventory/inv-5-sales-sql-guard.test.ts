// INV.5 — source guard for the unified sales-engine migration.
//
// Verifies the canonical sale primitive + inv_sell + the two upgraded order RPCs:
//   * signatures + security (DEFINER, pinned search_path) + grants (internal
//     helper is service-role-revoked; inv_sell / order RPCs are service_role-only);
//   * deterministic locking; PASS-1 validate (no writes) then PASS-2 apply;
//   * simple + variant sale, shelf spread biggest-first, zero-row deletion,
//     primary-location recompute, parent rollup = Σ variants, sold aggregation;
//   * fail-closed classified reasons; overflow guards;
//   * NO products mirror, NO stock_status (availability), audit immutable=true;
//   * Shopify RPC is grain-aware + no pre-claim; Talabat delegates to the primitive.
//
// PURE — source scan only. Run:
// node --conditions=react-server --experimental-strip-types --test lib/inventory/inv-5-sales-sql-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIG_DIR = join(ROOT, "supabase", "migrations");
const migFile = readdirSync(MIG_DIR).find((f) => /inv_5_sales_symmetry\.sql$/.test(f));
const RAW = migFile ? readFileSync(join(MIG_DIR, migFile), "utf8") : "";
const CODE = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
const lc = CODE.toLowerCase();

test("migration exists", () => {
  assert.ok(migFile, "inv_5_sales_symmetry.sql present");
  assert.ok(RAW.length > 0, "non-empty");
});

// ── signatures + security ─────────────────────────────────────────────────────

test("signatures: canonical primitive, inv_sell, and both order RPCs", () => {
  assert.ok(/create or replace function public\.inv_apply_sale_targets\(\s*p_targets\s+jsonb,\s*p_source\s+text,\s*p_external_id\s+text\s*\)/i.test(CODE), "primitive signature");
  assert.ok(/create or replace function public\.inv_sell\(\s*p_scope\s+text,\s*p_target_id\s+uuid,\s*p_quantity\s+integer,\s*p_source\s+text,\s*p_external_id\s+text\s*\)/i.test(CODE), "inv_sell signature");
  assert.ok(/create or replace function public\.process_shopify_order_deduction\(/i.test(CODE), "shopify RPC");
  assert.ok(/create or replace function public\.process_talabat_order_deduction\(/i.test(CODE), "talabat RPC");
});

test("security: all SECURITY DEFINER with pinned search_path", () => {
  assert.ok((lc.match(/security definer/g) ?? []).length >= 4, "all four functions are DEFINER");
  assert.ok((lc.match(/set search_path = public, pg_temp/g) ?? []).length >= 4, "pinned search_path on each");
});

test("grants: internal primitive revoked from service_role; entrypoints service_role-only", () => {
  assert.ok(/revoke all on function public\.inv_apply_sale_targets\(jsonb, text, text\) from service_role/i.test(CODE), "primitive not callable by service_role");
  assert.ok(/revoke all on function public\.inv_apply_sale_targets\(jsonb, text, text\) from authenticated/i.test(CODE));
  assert.equal(/grant execute on function public\.inv_apply_sale_targets/i.test(CODE), false, "primitive has NO grant (owner/DEFINER only)");
  for (const g of [
    /grant execute on function public\.inv_sell\(text, uuid, integer, text, text\) to service_role/i,
    /grant execute on function public\.process_shopify_order_deduction\([^)]*\) to service_role/i,
    /grant execute on function public\.process_talabat_order_deduction\(uuid, text, jsonb, jsonb\) to service_role/i,
  ]) assert.ok(g.test(CODE), `service_role grant: ${g}`);
});

// ── PASS 1 / PASS 2 + deterministic locking ───────────────────────────────────

test("deterministic locking + PASS-1 validate then PASS-2 apply", () => {
  assert.ok(/order by pid, vid nulls first/i.test(CODE), "deterministic aggregate/lock order");
  assert.ok(/order by sku, id for update/i.test(CODE), "siblings locked deterministically");
  assert.ok(/PASS 1/i.test(RAW) && /PASS 2/i.test(RAW), "documented two-pass structure");
});

// ── sale semantics ────────────────────────────────────────────────────────────

test("simple + variant sale: shelf spread biggest-first, delete zero rows, recompute primary, parent rollup", () => {
  assert.ok(/order by quantity desc, location asc, id asc/i.test(CODE), "biggest-first shelf spread");
  assert.ok(/delete from shelf_stock where inventory_id = v_inv_id and quantity = 0/i.test(CODE), "product zero-row removal");
  assert.ok(/delete from variant_shelf_stock where variant_id = v_vid and quantity = 0/i.test(CODE), "variant zero-row removal");
  assert.ok(/order by quantity desc, location asc\s+limit 1/i.test(CODE), "primary location recompute");
  assert.ok(/set stock_quantity = v_sum,/i.test(CODE), "parent rollup = Σ variants");
  assert.ok(/v_rem <> 0 then raise exception 'sale_shelf_remainder'/i.test(CODE), "no clamp: whole qty must be placed");
});

test("sold_quantity advances (aggregated per parent) with overflow guard", () => {
  assert.ok(/sold_quantity = coalesce\(sold_quantity, 0\) \+ v_qty/i.test(CODE), "simple sold advance");
  assert.ok(/sold_quantity = coalesce\(sold_quantity, 0\) \+ v_prod\.total_qty/i.test(CODE), "variant parent sold += product total");
  assert.ok(/> 2147483647 then raise exception 'sale_sold_overflow'/i.test(CODE), "sold overflow guarded");
});

test("classified fail-closed reasons + aggregate/insufficient guards", () => {
  for (const r of ["insufficient_stock", "inventory_inconsistent", "invalid_plan", "parent_has_shelf_rows"]) {
    assert.ok(new RegExp(`'${r}'`).test(CODE), `reason ${r} present`);
  }
  assert.ok(/if v_qty > v_avail_raw then[\s\S]*insufficient_stock/i.test(CODE), "insufficient stock fail-closed");
  assert.ok(/v_sum <> v_avail then[\s\S]*inventory_inconsistent/i.test(CODE), "parent-drift fail-closed");
});

// ── boundaries: no mirror, no availability, immutable audit ────────────────────

test("no products mirror, no stock_status; audit is immutable stock_out sale", () => {
  assert.equal(/update\s+products\b|from\(["']products["']\)|public\.products/i.test(CODE), false, "never touches the products table");
  assert.equal(/stock_status/i.test(CODE), false, "never writes availability");
  assert.ok(/'immutable', true/.test(CODE), "audit rows are immutable");
  assert.ok(/'reason', 'sale'/.test(CODE) && /'direction', 'out'/.test(CODE), "stock_out sale audit");
  assert.ok(/'action_type'|'stock_out'/.test(CODE), "stock_out action");
});

// ── Shopify RPC: grain-aware + no pre-claim; Talabat delegation ───────────────

test("Shopify RPC is grain-aware, advisory-locked, delegates to the primitive, no pre-claim", () => {
  assert.ok(/pg_advisory_xact_lock\(hashtext\(p_order_id\)\)/i.test(CODE), "advisory lock on the order id");
  assert.ok(/inv_apply_sale_targets\(p_deductions,/i.test(CODE), "delegates the sale to the primitive");
  assert.ok(/if v_status is distinct from 'applied' then\s*[\s\S]*?return v_res;/i.test(CODE), "classified failure records NOTHING");
  // the completed ledger row is inserted only AFTER a successful sale (no pending pre-claim)
  const salePos = lc.indexOf("inv_apply_sale_targets(p_deductions");
  const insertPos = lc.indexOf("insert into shopify_synced_orders", salePos);
  assert.ok(salePos > 0 && insertPos > salePos, "ledger insert follows the successful sale");
});

test("Talabat RPC keeps dedup + safe resolution and delegates the numeric sale", () => {
  assert.ok(/pg_advisory_xact_lock\(hashtext\(p_dedup_key\)\)/i.test(CODE), "dedup advisory lock preserved");
  assert.ok(/duplicate_order/.test(CODE) && /missing_dedup_key/.test(CODE), "dedup classifications preserved");
  assert.ok(/inv_apply_sale_targets\(v_canon, 'talabat'/i.test(CODE), "delegates to the primitive with resolved targets");
  assert.ok(/jsonb_strip_nulls/.test(CODE), "deep-safe resolution projection preserved");
  assert.ok(/'processed'[\s\S]*deductedUnits[\s\S]*products[\s\S]*variants/i.test(CODE), "processed result carries canonical fields");
});
