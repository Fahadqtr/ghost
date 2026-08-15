// INV.6A — Runtime Closure guard. Static source/SQL scans pinning that the last
// runtime numeric writers are converged onto atomic RPCs, the foundation
// migration is a safe additive layer, and every movement RPC is SECURITY DEFINER,
// service-role-only, atomic, and clamp-free with the exact fail-closed semantics.
//
// PURE — source scan only. Run:
// node --conditions=react-server --experimental-strip-types --test lib/inventory/inv-6a-runtime-closure-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const MIG_DIR = join(ROOT, "supabase", "migrations");
const migFile = readdirSync(MIG_DIR).find((f) => /inv_6a_runtime_closure\.sql$/.test(f));
const RAW = migFile ? readFileSync(join(MIG_DIR, migFile), "utf8") : "";
const MIG = RAW.replace(/--[^\n]*/g, "");     // SQL line comments stripped
const lc = MIG.toLowerCase();

// Locate a function body case-insensitively (the SQL keyword is FUNCTION), and
// slice from the original-case MIG so mixed-case identifiers stay matchable.
function fnBody(fn: string): string {
  const at = lc.indexOf(`function public.${fn}`);
  if (at < 0) return "";
  const end = lc.indexOf("$$;", at);
  return MIG.slice(at, end < 0 ? undefined : end);
}

// The four movement RPC signatures the runtime drives.
const MOVEMENT_RPCS = [
  "inv_record_product_movement",
  "inv_edit_product_movement",
  "inv_delete_product_movement",
  "inv_reverse_product_movement",
];

// ── Foundation migration: FKs + uniqueness ────────────────────────────────────

test("migration exists and adds the two shelf FKs (ON DELETE CASCADE)", () => {
  assert.ok(migFile, "inv_6a_runtime_closure.sql present");
  assert.ok(/shelf_stock_inventory_id_fkey[\s\S]*references\s+(public\.)?inventory\(id\)\s+on delete cascade/i.test(MIG), "shelf_stock → inventory FK cascade");
  assert.ok(/variant_shelf_stock_variant_id_fkey[\s\S]*references\s+(public\.)?product_variants\(id\)\s+on delete cascade/i.test(MIG), "variant_shelf_stock → product_variants FK cascade");
});

test("migration adds UNIQUE (product_id) on inventory", () => {
  assert.ok(/inventory_product_id_key\s+unique\s*\(product_id\)/i.test(MIG), "exactly-one-inventory unique constraint");
});

test("migration is ADDITIVE — no INV.6B enforcement (NOT NULL / CHECK / RLS / privilege / triggers)", () => {
  assert.equal(/\bset\s+not\s+null\b/i.test(MIG), false, "no NOT NULL changes (INV.6B)");
  assert.equal(/add\s+constraint[^;]*\bcheck\b/i.test(MIG), false, "no CHECK constraints (INV.6B)");
  assert.equal(/create\s+policy|alter\s+table[^;]*enable\s+row\s+level|drop\s+policy/i.test(MIG), false, "no RLS policy changes (INV.6B)");
  assert.equal(/create\s+trigger/i.test(MIG), false, "no invariant triggers (INV.6B)");
  assert.equal(/revoke[^;]*\b(update|insert|delete|select)\b[^;]*\bon\s+table\b/i.test(MIG), false, "no table privilege revocations (INV.6B)");
});

// ── Movement RPC security ─────────────────────────────────────────────────────

test("every movement function is SECURITY DEFINER with a safe explicit search_path", () => {
  const fns = ["inv_apply_simple_delta", ...MOVEMENT_RPCS];
  for (const fn of fns) {
    const body = fnBody(fn);
    assert.ok(body.length > 0, `${fn} defined`);
    assert.ok(/security definer/i.test(body.slice(0, 400)), `${fn} is SECURITY DEFINER`);
    assert.ok(/set search_path = public, pg_temp/i.test(body.slice(0, 400)), `${fn} pins search_path`);
  }
});

test("the internal primitive is revoked from EVERYONE incl. service_role", () => {
  for (const who of ["public", "anon", "authenticated", "service_role"]) {
    assert.ok(new RegExp(`revoke all on function public\\.inv_apply_simple_delta\\(uuid, integer, integer\\) from ${who}`, "i").test(MIG),
      `inv_apply_simple_delta revoked from ${who}`);
  }
  assert.equal(/grant execute on function public\.inv_apply_simple_delta/i.test(MIG), false, "primitive is never GRANTed");
});

test("each outer movement RPC is revoked from public/anon/authenticated and GRANTed to service_role only", () => {
  for (const fn of MOVEMENT_RPCS) {
    for (const who of ["public", "anon", "authenticated"]) {
      assert.ok(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from ${who}`, "i").test(MIG), `${fn} revoked from ${who}`);
    }
    assert.ok(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role`, "i").test(MIG), `${fn} granted to service_role`);
  }
});

// ── Movement RPC scope: mutates only inventory + malak_audit ───────────────────

test("movement RPCs mutate ONLY inventory + malak_audit — never products/variants/shelves/availability", () => {
  // Slice from the primitive to the end (all movement functions).
  const region = MIG.slice(MIG.indexOf("function public.inv_apply_simple_delta"));
  const updates = [...region.matchAll(/update\s+(public\.)?([a-z_]+)\s+set/gi)].map((m) => m[2].toLowerCase());
  for (const t of updates) assert.ok(["inventory"].includes(t), `unexpected UPDATE target in a movement RPC: ${t}`);
  const inserts = [...region.matchAll(/insert\s+into\s+(public\.)?([a-z_]+)/gi)].map((m) => m[2].toLowerCase());
  for (const t of inserts) assert.ok(t === "malak_audit", `unexpected INSERT target in a movement RPC: ${t}`);
  assert.equal(/delete\s+from\s+(public\.)?(products|product_variants|inventory|shelf_stock|variant_shelf_stock)/i.test(region), false, "no row deletes in the movement RPCs");
  assert.equal(/stock_status/i.test(region), false, "never touches availability");
  assert.equal(/set[^;]*products\.stock_quantity|update\s+(public\.)?products\b/i.test(region), false, "never writes the retired products mirror");
});

// ── No clamp; exact fail-closed semantics; bigint overflow ─────────────────────

test("movement RPCs never clamp — no GREATEST/max; explicit fail-closed reasons instead", () => {
  const region = lc.slice(lc.indexOf("function public.inv_apply_simple_delta"));
  assert.equal(/greatest\s*\(/.test(region), false, "no GREATEST(...) clamp");
  assert.equal(/least\s*\(\s*0/.test(region), false, "no least(0,...) clamp");
  for (const reason of ["insufficient_stock", "overflow", "cannot_undo_consumed_stock", "sold_inconsistent"]) {
    assert.ok(region.includes(reason), `explicit fail-closed reason present: ${reason}`);
  }
});

test("movement RPCs compute in bigint with int4-overflow guards + rowcount checks", () => {
  const region = lc.slice(lc.indexOf("function public.inv_apply_simple_delta"));
  assert.ok(/::bigint/.test(region), "bigint arithmetic");
  assert.ok((region.match(/2147483647/g) ?? []).length >= 4, "int4-overflow guards on stock + sold across the RPCs");
  assert.ok((region.match(/get diagnostics [a-z_]+ = row_count/g) ?? []).length >= 5, "rowcount checked on the critical writes");
});

// ── record: canonical reason + sale sold semantics ────────────────────────────

test("record: canonical 'sale' reason + sold advances only for a sale-out", () => {
  const body = fnBody("inv_record_product_movement");
  assert.ok(/lower\(btrim\(p_reason\)\)\s*=\s*'sale'/i.test(body), "reason canonicalized to 'sale' case-insensitively");
  assert.ok(/direction\s*=\s*'out'\s+and\s+v_reason\s*=\s*'sale'/i.test(body), "sold delta only for a sale-out");
  assert.ok(/action_type/i.test(body) && /'stock_in'|'stock_out'/.test(body), "writes a stock_in/stock_out audit row");
});

test("primitive sold contract: soldDelta > 0 only when delta < 0 and soldDelta = -delta", () => {
  const body = fnBody("inv_apply_simple_delta");
  assert.ok(/p_sold_delta\s*>\s*0\s+and\s+not\s*\(p_delta\s*<\s*0\s+and\s+p_sold_delta\s*=\s*-p_delta\)/i.test(body), "strict sold contract");
  assert.ok(/product_has_variants/.test(body) && /product_has_shelf_rows/.test(body), "rejects variant / shelf-tracked products");
});

// ── edit / delete / reverse: immutability + review state + sale sold delta ─────

test("edit/delete/reverse enforce channel immutability (INV.5 rule) and review state", () => {
  for (const fn of ["inv_edit_product_movement", "inv_delete_product_movement", "inv_reverse_product_movement"]) {
    const body = fnBody(fn);
    assert.ok(/immutable/i.test(body) && /'shopify','talabat'|'shopify', 'talabat'/.test(body), `${fn} applies the channel immutability rule`);
    assert.ok(/movement_locked/.test(body), `${fn} returns movement_locked for a locked audit`);
    assert.ok(/for update/i.test(body), `${fn} locks the audit row`);
    assert.ok(/not_a_product_movement/.test(body), `${fn} rejects non stock_in/out rows`);
  }
});

test("delete: undoing an IN needs current stock; a sale-OUT restores stock and lowers sold", () => {
  const body = fnBody("inv_delete_product_movement");
  assert.ok(/already_deleted/.test(body), "repeat delete is a classified failure");
  assert.ok(/reversed/.test(body), "already-reversed rows are not inverted again");
  assert.ok(/cannot_undo_consumed_stock/.test(body), "consumed-IN cannot be undone (no clamp)");
  assert.ok(/sold_inconsistent/.test(body), "insufficient sold fails closed");
});

test("reverse: exact inverse + a distinct immutable reversal audit row", () => {
  const body = fnBody("inv_reverse_product_movement");
  assert.ok(/already_reversed/.test(body), "repeat reverse is a classified failure");
  assert.ok(/'movement_reversal'/.test(body), "reversal audit tagged source=movement_reversal");
  assert.ok(/'immutable',\s*true/.test(body), "reversal audit is immutable (never editable/pending)");
  assert.ok(/originalAuditId/.test(body), "reversal audit links the original");
  assert.ok(/'reversed'/.test(body), "original marked reversed");
});

// ── Runtime closure: no direct numeric/structural writers remain ───────────────

const DML = /\.from\(\s*["'](inventory|shelf_stock|variant_shelf_stock)["']\s*\)\s*\.(update|insert|upsert|delete)|\.from\(\s*["']product_variants["']\s*\)\s*\.(insert|delete)|\.from\(\s*["']product_variants["']\s*\)\s*\.update\(\s*\{[^}]*stock_quantity/;

test("movements.ts is converged — no direct numeric DML, routes through the engine RPCs", () => {
  const mv = read("lib/inventory/movements.ts");
  assert.equal(DML.test(mv), false, "no direct inventory/variant/shelf write");
  assert.ok(/recordProductMovement|editProductMovement|deleteProductMovement|reverseMovement/.test(mv), "routes to the engine movement wrappers");
  assert.ok(/logAuthoritativeStockTransition/.test(mv), "uses the authoritative transition (not totalStock)");
  assert.equal(/Math\.max\(/.test(mv), false, "no clamp-based arithmetic");
});

test("staff/actions.ts no longer lazily seeds an inventory row (fail-closed instead)", () => {
  const s = read("app/staff/actions.ts");
  assert.equal(/\.from\(\s*["']inventory["']\s*\)\s*\.insert/.test(s), false, "no inventory-row seed insert");
  assert.equal(/\.from\(\s*["']product_variants["']\s*\)\s*\.(insert|delete)/.test(s), false, "no direct variant insert/delete");
  assert.ok(/صف المخزون غير موجود لهذا المنتج/.test(s), "missing inventory row fails closed with an operator message");
});

test("engine.ts exposes real movement wrappers; the not-implemented machinery is gone", () => {
  const e = read("lib/inventory/engine.ts");
  for (const fn of ["recordProductMovement", "editProductMovement", "deleteProductMovement", "reverseMovement", "adjust", "receive"]) {
    assert.ok(new RegExp(`export async function ${fn}\\(`).test(e), `${fn} is a real async wrapper`);
  }
  assert.equal(/NOT_IMPLEMENTED_OPS|InventoryEngineNotImplementedError|notImplemented/.test(e), false, "no not-implemented stubs remain");
  for (const rpc of MOVEMENT_RPCS) assert.ok(e.includes(rpc), `engine drives ${rpc}`);
});

test("movements-compute.ts no longer clamps (planEdit/planDelete retired)", () => {
  const c = strip(read("lib/inventory/movements-compute.ts"));
  assert.equal(/Math\.max\(/.test(c), false, "no Math.max clamp");
  assert.equal(/export function planEdit|export function planDelete/.test(c), false, "clamp planners removed");
});

test("create authority: variant parent seed = Σ variants; blank variant stock → 0, malformed fails closed", () => {
  const pc = read("lib/products/product-create.ts");
  assert.ok(/computeVariantParentSeed/.test(pc), "variant seed derived from Σ variants");
  assert.ok(/invalid_variant_stock/.test(pc), "malformed variant stock fails closed");
  assert.ok(/invalid_seed/.test(pc), "malformed simple seed fails closed");
  const seed = read("lib/products/inventory-seed.ts");
  assert.ok(/normalizeVariantStockForSeed/.test(seed), "blank-normalizing helper present");
  assert.ok(/computeVariantParentSeed/.test(seed), "Σ-variants seed helper present");
  assert.ok(/return 0;/.test(seed), "blank/null variant stock normalizes to 0");
});

test("totalStock does not sum parent + variants (double-count fixed)", () => {
  const body = strip(read("lib/tasks/total-stock.ts"));
  // A variant product returns Σ variants and does NOT then add the inventory rows.
  assert.ok(/export async function totalStock/.test(body), "canonical totalStock lives in the framework-free module");
  assert.ok(/parent_product_id/.test(body) && /return sum;/.test(body), "variant total is Σ variants with an early return");
  // stock-tasks.ts re-exports it (existing callers keep their import path).
  assert.ok(/export \{ totalStock \} from "\.\/total-stock"/.test(read("lib/tasks/stock-tasks.ts")), "re-exported from stock-tasks");
});

test("full product delete uses FK cascade — no direct numeric child cleanup, no shelf-cleanup helper", () => {
  for (const f of ["app/(app)/products/actions.ts", "app/(app)/catalog/health/actions.ts"]) {
    const s = read(f);
    assert.equal(/\.from\(\s*["'](product_variants|inventory|variant_shelf_stock|channel_products)["']\s*\)\s*\.delete/.test(s), false, `${f} has no manual child delete`);
    assert.equal(/deleteShelfStockForProduct/.test(s), false, `${f} no longer calls the retired shelf-cleanup helper`);
    assert.ok(/\.from\(\s*["']products["']\s*\)\s*\.delete\(\)/.test(s), `${f} deletes the product row (cascade owns the rest)`);
  }
});
