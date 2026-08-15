// INV.4E — source guard for the atomic archive/restore migration.
//
// Verifies the migration:
//   • drops the products.stock_quantity DEFAULT (mirror retirement — no column
//     drop, no mass value rewrite);
//   • defines archive_product_bundle + restore_product_archive as SECURITY
//     DEFINER, pinned search_path, service_role-only EXECUTE (never anon /
//     authenticated / public);
//   • ARCHIVE: snapshots a version-2 bundle including BOTH shelf tables, then
//     deletes the product + every dependent in one transaction (rowcount-checked
//     product delete; any failure rolls back → no orphan);
//   • RESTORE: supports legacy v1 bundles (shelf arrays default to []), validates
//     references / quantities / duplicate identity, reconciles to the
//     authoritative model, strips the products.stock_quantity mirror, and rolls
//     back the whole re-insert on any conflict (archive row remains);
//   • neither RPC touches stock_status (availability) or products.stock_quantity.
//
// PURE — source scan only. Run:
// node --conditions=react-server --experimental-strip-types --test lib/inventory/inv-4e-rpc-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIG_DIR = join(ROOT, "supabase", "migrations");
const migFile = readdirSync(MIG_DIR).find((f) => /inv_4e_archive_restore\.sql$/.test(f));
const RAW = migFile ? readFileSync(join(MIG_DIR, migFile), "utf8") : "";
const CODE = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
const lc = CODE.toLowerCase();

test("migration exists", () => {
  assert.ok(migFile, "inv_4e_archive_restore.sql present");
  assert.ok(RAW.length > 0, "non-empty");
});

// ── mirror retirement: default dropped, column NOT dropped, no mass update ─────

test("drops the products.stock_quantity DEFAULT without dropping the column or rewriting values", () => {
  assert.ok(/alter table public\.products\s+alter column stock_quantity drop default/i.test(CODE),
    "DEFAULT dropped → fresh inserts never resurrect a 0 mirror");
  assert.equal(/drop column\s+stock_quantity/i.test(CODE), false, "column is NOT dropped in INV.4E");
  assert.equal(/update\s+public\.products\s+set\s+stock_quantity/i.test(CODE), false, "no mass value rewrite");
});

// ── both RPCs: signatures + security ──────────────────────────────────────────

test("archive_product_bundle(uuid, text) → jsonb, SECURITY DEFINER + pinned search_path", () => {
  assert.ok(/create or replace function public\.archive_product_bundle\(\s*p_product_id uuid,\s*p_archived_by text\s*\)/i.test(CODE),
    "archive signature");
  assert.ok(/create or replace function public\.restore_product_archive\(\s*p_archive_id uuid\s*\)/i.test(CODE),
    "restore signature");
  const definers = (lc.match(/security definer/g) ?? []).length;
  assert.ok(definers >= 2, "both RPCs are SECURITY DEFINER (full bundle restoration crosses RLS)");
  const paths = (lc.match(/set search_path = public, pg_temp/g) ?? []).length;
  assert.ok(paths >= 2, "both RPCs pin search_path");
});

test("grants: service_role ONLY (revoke public/anon/authenticated)", () => {
  for (const fn of ["archive_product_bundle(uuid, text)", "restore_product_archive(uuid)"]) {
    const f = fn.replace(/[()]/g, "\\$&").replace(/,\s*/g, ", ");
    assert.ok(new RegExp(`revoke all on function public\\.${f} from public`, "i").test(CODE), `${fn} revoke public`);
    assert.ok(new RegExp(`revoke all on function public\\.${f} from anon`, "i").test(CODE), `${fn} revoke anon`);
    assert.ok(new RegExp(`revoke all on function public\\.${f} from authenticated`, "i").test(CODE), `${fn} revoke authenticated`);
    assert.ok(new RegExp(`grant execute on function public\\.${f} to service_role`, "i").test(CODE), `${fn} grant service_role`);
  }
});

// ── archive atomicity + bundle v2 ─────────────────────────────────────────────

test("archive locks the product, fails closed on missing / ambiguous inventory", () => {
  assert.ok(/from public\.products where id = p_product_id for update/i.test(CODE), "locks the product");
  assert.ok(/'product_not_found'/.test(CODE), "missing product fails closed");
  assert.ok(/'inventory_ambiguous'/.test(CODE), "more than one inventory row fails closed");
  assert.ok(/order by id for update/i.test(CODE), "deterministic dependent locks");
});

test("archive bundle is version 2 and includes BOTH shelf tables + inventory/variants/channels", () => {
  assert.ok(/'version',\s*2/.test(CODE), "bundle tagged version 2");
  for (const k of ["'product'", "'inventory'", "'variants'", "'shelf_stock'", "'variant_shelf_stock'", "'channel_products'"]) {
    assert.ok(CODE.includes(k), `bundle carries ${k}`);
  }
});

test("archive deletes every dependent then the product, rowcount-checked, atomic rollback", () => {
  for (const t of ["variant_shelf_stock", "shelf_stock", "channel_products", "product_variants", "inventory"]) {
    assert.ok(new RegExp(`delete from public\\.${t}`, "i").test(CODE), `deletes ${t}`);
  }
  assert.ok(/delete from public\.products where id = p_product_id/i.test(CODE), "deletes the product");
  assert.ok(/get diagnostics v_rows = row_count/i.test(CODE) && /if v_rows <> 1 then/i.test(CODE), "product delete rowcount-checked");
  assert.ok(/raise exception/i.test(CODE), "a bad delete raises → rollback");
  assert.ok(/exception\s+when others then[\s\S]*'archive_failed'/i.test(CODE), "any failure → archive_failed (full rollback)");
});

// ── restore: legacy support + validation + reconciliation ─────────────────────

test("restore supports legacy v1 bundles (version defaults to 1, shelf arrays default to [])", () => {
  assert.ok(/coalesce\(nullif\(v_bundle->>'version', ''\)::integer, 1\)/i.test(CODE), "version defaults to 1");
  assert.ok(/coalesce\(v_bundle->'shelf_stock', '\[\]'::jsonb\)/i.test(CODE), "missing shelf_stock ⇒ []");
  assert.ok(/coalesce\(v_bundle->'variant_shelf_stock', '\[\]'::jsonb\)/i.test(CODE), "missing variant_shelf_stock ⇒ []");
});

test("restore validates references, quantities, duplicate identity — with fixed reason codes", () => {
  for (const code of [
    "archive_not_found", "bundle_invalid", "inventory_row_invalid", "reference_mismatch",
    "duplicate_identity", "malformed_quantity", "parent_has_shelf_rows",
    "restore_conflict", "restore_failed",
  ]) {
    assert.ok(new RegExp(`'${code}'`).test(CODE), `reason ${code} present`);
  }
  assert.ok(/<>\s*trunc\(/i.test(CODE), "rejects fractional quantities");
  assert.ok(/>\s*2147483647/.test(CODE), "int4 overflow guarded");
  assert.ok(/count\(distinct \(e->>'id'\)\)/i.test(CODE), "duplicate variant identity checked");
});

test("restore reconciliation: variant parent = Σ variants; simple shelves = Σ + primary location; no-shelf preserves inventory", () => {
  // variant parent pool = Σ reconciled variant stocks
  assert.ok(/sum\(fs\)/i.test(CODE), "parent = Σ variant final stocks");
  // per-variant stock = Σ its variant-shelf rows when present
  assert.ok(/variant_shelf_stock|v_var_shelf/i.test(CODE), "variant shelves reconcile variant stock");
  // simple: primary shelf = largest qty then location ASC
  assert.ok(/order by \(e->>'quantity'\)::numeric desc, e->>'location' asc/i.test(CODE), "deterministic primary location");
  // parent-level shelves on a variant product are rejected
  assert.ok(/parent_has_shelf_rows/.test(CODE), "product-level shelves on a variant product rejected");
  // no-shelf simple preserves the archived inventory quantity; variant parent location NULL
  assert.ok(/v_inv_row->>'stock_quantity'/.test(CODE), "no-shelf simple preserves archived inventory quantity");
});

test("restore strips the products.stock_quantity mirror and never derives availability", () => {
  assert.ok(/jsonb_populate_record\(null::public\.products,\s*v_product - 'stock_quantity'\)/i.test(CODE),
    "product insert strips the retired stock_quantity mirror");
  assert.equal(/stock_status/i.test(CODE), false, "neither RPC touches stock_status (availability boundary)");
});

test("restore applies in dependency order and deletes the archive row only on full success", () => {
  const insertOrder = ["public.products", "public.inventory", "public.product_variants", "public.shelf_stock", "public.variant_shelf_stock", "public.channel_products"];
  let last = -1;
  for (const t of insertOrder) {
    const idx = CODE.indexOf(`insert into ${t}`.toUpperCase()) >= 0
      ? CODE.toUpperCase().indexOf(`INSERT INTO ${t.toUpperCase()}`)
      : CODE.toLowerCase().indexOf(`insert into ${t}`);
    assert.ok(idx > last, `insert ${t} appears after the previous insert (dependency order)`);
    last = idx;
  }
  const delArchiveIdx = lc.indexOf("delete from public.product_archive where id = p_archive_id");
  assert.ok(delArchiveIdx > last, "archive row deleted only after every insert");
});

test("restore rolls back on unique / FK conflict (archive row remains) → restore_conflict", () => {
  assert.ok(/when unique_violation then[\s\S]*'restore_conflict'/i.test(CODE), "unique conflict → restore_conflict");
  assert.ok(/when foreign_key_violation then[\s\S]*'restore_conflict'/i.test(CODE), "FK conflict → restore_conflict");
  assert.ok(/when others then[\s\S]*'restore_failed'/i.test(CODE), "other failure → restore_failed");
});

// ── neither RPC resurrects the products mirror ────────────────────────────────

test("the only 'stock_quantity' key the product populate touches is the STRIP", () => {
  // The product insert must build its record from (v_product - 'stock_quantity');
  // it must NEVER add a stock_quantity key back onto the products populate.
  assert.equal(/populate_record\(null::public\.products,[^;]*jsonb_build_object\('stock_quantity'/i.test(CODE), false,
    "product populate never re-adds a stock_quantity key");
  // (inventory DOES set an authoritative stock_quantity — that is a different table.)
  assert.ok(/populate_record\(\s*null::public\.inventory,[\s\S]*jsonb_build_object\('stock_quantity', v_final_stock/i.test(CODE),
    "inventory populate sets the authoritative stock_quantity");
});
