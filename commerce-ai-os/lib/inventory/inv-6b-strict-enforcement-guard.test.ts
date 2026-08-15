// INV.6B — runtime-convergence + strict-enforcement guard.
//
// Two layers, both a PURE source scan (no DB, no network, no React):
//   1. RUNTIME CONVERGENCE — every create/edit path is compatible with a database
//      in which a direct inventory/variant write is impossible for every role:
//        • the create cores insert ONLY the products row and delegate the fresh
//          inventory (+ variant) seed to the injected service-role initializer;
//        • every create caller injects that initializer (session client for product
//          METADATA where RLS applies; admin/service-role client for the structural
//          RPCs); the editor's atomic variant sync runs on the admin client;
//        • archive restore stays exempt (its own atomic RPC, not the create core).
//   2. MIGRATION SHAPE — the bridge (Migration A) exposes the service-role
//      initializer RPCs, and the strict lockdown (Migration B) installs the auto-seed
//      trigger, the non-negative CHECKs, the deferred integrity triggers, the ACL
//      lockdown, and the final sync_product_variants → service_role-only revoke.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/inventory/inv-6b-strict-enforcement-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const INV_INSERT = /\.from\(\s*["']inventory["']\s*\)\s*\.(insert|upsert|delete)/;
const PV_STRUCT = /\.from\(\s*["']product_variants["']\s*\)\s*\.(insert|delete)/;

const BRIDGE = "supabase/migrations/20260815125659_inv_6b_runtime_bridge.sql";
const STRICT = "supabase/migrations/20260815125704_inv_6b_strict_enforcement.sql";

// ── 1. the create cores delegate to the injected initializer ──────────────────

test("createProductCore inserts only products + delegates to the injected initializer", () => {
  const src = read("lib/products/product-create.ts");
  assert.ok(/initialize:\s*InitializeInventoryState/.test(src), "takes the initializer as a parameter");
  assert.ok(/await initialize\(/.test(src), "delegates authoritative state to it");
  assert.equal(INV_INSERT.test(src), false, "no direct inventory insert/upsert/delete");
  assert.equal(PV_STRUCT.test(src), false, "no direct product_variants insert/delete");
});

test("createProductsBatchCore inserts only products + delegates to the injected batch initializer", () => {
  const src = read("lib/products/product-create-batch.ts");
  assert.ok(/initializeSimple:\s*InitializeSimpleProducts/.test(src), "takes the batch initializer as a parameter");
  assert.ok(/await initializeSimple\(/.test(src), "delegates authoritative state to it");
  assert.equal(INV_INSERT.test(src), false, "no direct inventory insert/upsert/delete");
});

test("the initializer adapter is server-only, fail-closed, and drives the bridge RPCs", () => {
  const src = read("lib/products/inventory-initializer.ts");
  assert.ok(/^import "server-only";/m.test(src), "server-only");
  assert.ok(/inv_initialize_product_state/.test(src), "single-product RPC");
  assert.ok(/inv_initialize_simple_products/.test(src), "batch RPC");
  // Fail-closed: a transport error / non-'applied' status is a failure, never a fallback.
  assert.ok(/if \(error\)/.test(src), "handles the transport error");
  assert.ok(/status !== "applied"/.test(src), "requires status:applied");
  assert.equal(INV_INSERT.test(src), false, "the adapter itself never writes inventory directly");
});

// ── 2. every create caller injects the service-role initializer ────────────────

interface Caller {
  file: string;
  label: string;
  /** the substring proving the initializer is injected into the core call */
  inject: string;
  /** true = product METADATA create runs on the session client (RLS applies) */
  sessionMetadata: boolean;
}

const CALLERS: Caller[] = [
  { file: "app/(v2)/v2/catalog/new/actions.ts", label: "V2 Create", inject: "makeInventoryInitializer(admin)", sessionMetadata: true },
  { file: "app/(v2)/v2/catalog/import/actions.ts", label: "V2 Import", inject: "makeInventoryInitializer", sessionMetadata: true },
  { file: "app/api/malak/commit/route.ts", label: "Malak", inject: "makeInventoryInitializer(sb)", sessionMetadata: false },
  { file: "app/(app)/import-export/shopify-actions.ts", label: "Shopify", inject: "makeInventoryInitializer(sb)", sessionMetadata: false },
  { file: "app/(app)/import-export/snoonu-actions.ts", label: "Snoonu", inject: "makeSimpleProductsInitializer(admin)", sessionMetadata: false },
  { file: "app/(app)/import-export/pure-seoul-actions.ts", label: "Pure Seoul", inject: "makeSimpleProductsInitializer(admin)", sessionMetadata: false },
  { file: "app/staff/actions.ts", label: "Staff", inject: "makeInventoryInitializer(admin)", sessionMetadata: false },
];

for (const c of CALLERS) {
  test(`${c.label} injects the service-role initializer and writes no inventory/variant directly`, () => {
    const src = read(c.file);
    assert.ok(src.includes(c.inject), `${c.label} injects ${c.inject}`);
    assert.ok(/from "@\/lib\/products\/inventory-initializer"/.test(src), `${c.label} imports the initializer`);
    assert.equal(INV_INSERT.test(src), false, `${c.label} performs no direct inventory write`);
    assert.equal(PV_STRUCT.test(src), false, `${c.label} performs no direct product_variants insert/delete`);
  });
}

test("V2 Create + V2 Import write product METADATA through the SESSION client (RLS)", () => {
  for (const c of CALLERS.filter((x) => x.sessionMetadata)) {
    const src = read(c.file);
    assert.ok(/createProductCore\(supabase,/.test(src), `${c.label} injects the session client for metadata`);
  }
});

// ── 3. the editor's atomic variant sync runs on the service-role client ────────

test("the product editor runs the atomic variant sync on the admin (service-role) client", () => {
  const save = read("lib/products/product-save.ts");
  assert.ok(/variantSyncClient\?:\s*ProductSaveClient/.test(save), "the sync client is an injectable seam");
  assert.ok(/syncProductVariants\(opts\.variantSyncClient \?\? client,/.test(save), "sync uses the injected client when present");
  const edit = read("app/(v2)/v2/catalog/[id]/edit/actions.ts");
  assert.ok(/variantSyncClient:\s*admin/.test(edit), "the V2 editor injects the admin client for the sync");
});

test("V2 Import runs its variant append on the admin (service-role) client", () => {
  const src = read("app/(v2)/v2/catalog/import/actions.ts");
  assert.ok(/syncProductVariants\(admin,/.test(src), "variant append uses the admin client");
  assert.equal(/syncProductVariants\(supabase,/.test(src), false, "no session-client variant sync remains");
});

// ── 4. archive restore stays EXEMPT (its own atomic RPC, not the create core) ──

test("archive restore is exempt — uses restore_product_archive, never a create core", () => {
  const src = read("app/(app)/products/archive/actions.ts");
  assert.ok(/restore_product_archive/.test(src), "delegates to the atomic restore RPC");
  assert.equal(/createProductCore\(/.test(src), false, "does not use the single create core");
  assert.equal(/createProductsBatchCore/.test(src), false, "does not use the batch create core");
  assert.equal(INV_INSERT.test(src), false, "performs no direct inventory write");
});

// ── 5. Migration A (bridge) exposes the service-role initializer RPCs ──────────

test("bridge migration defines both initializer RPCs, service_role-only, SECURITY DEFINER", () => {
  const sql = read(BRIDGE);
  for (const fn of ["inv_initialize_product_state", "inv_initialize_simple_products"]) {
    assert.ok(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}`).test(sql), `${fn} defined`);
    assert.ok(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}[^;]*TO service_role`).test(sql), `${fn} granted to service_role`);
    assert.ok(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}[^;]*FROM authenticated`).test(sql), `${fn} revoked from authenticated`);
  }
  assert.ok(/SECURITY DEFINER/.test(sql), "SECURITY DEFINER");
  // The bridge keeps authenticated EXECUTE on sync_product_variants TEMPORARILY.
  assert.ok(/GRANT EXECUTE ON FUNCTION public\.sync_product_variants\(uuid, jsonb\) TO authenticated/.test(sql), "bridge keeps authenticated sync temporarily");
});

// ── 6. Migration B (strict lockdown) installs the enforcement layer ────────────

test("strict migration installs the auto-seed trigger", () => {
  const sql = read(STRICT);
  assert.ok(/CREATE OR REPLACE FUNCTION public\.inv_seed_inventory_on_product_insert/.test(sql), "auto-seed function");
  assert.ok(/CREATE TRIGGER trg_inv_seed_inventory/.test(sql), "auto-seed trigger");
});

test("strict migration adds non-negative CHECK constraints on every quantity column", () => {
  const sql = read(STRICT);
  for (const c of [
    "inventory_stock_quantity_nonneg",
    "inventory_sold_quantity_nonneg",
    "product_variants_stock_quantity_nonneg",
    "shelf_stock_quantity_nonneg",
    "variant_shelf_stock_quantity_nonneg",
  ]) {
    assert.ok(sql.includes(c), `${c} CHECK present`);
  }
});

test("strict migration installs deferred integrity constraint triggers", () => {
  const sql = read(STRICT);
  assert.ok(/inv_assert_product_integrity/.test(sql), "integrity assertion function");
  const triggers = (sql.match(/CREATE CONSTRAINT TRIGGER trg_inv_integrity_/g) || []).length;
  assert.ok(triggers >= 5, `all five constraint triggers present (found ${triggers})`);
  assert.ok(/DEFERRABLE INITIALLY DEFERRED/.test(sql), "triggers are deferred");
});

test("strict migration locks down table ACLs and sync_product_variants to service_role", () => {
  const sql = read(STRICT);
  for (const t of ["inventory", "product_variants", "shelf_stock", "variant_shelf_stock"]) {
    assert.ok(new RegExp(`REVOKE ALL ON TABLE public\\.${t} FROM authenticated`).test(sql), `${t} revoked from authenticated`);
  }
  // inventory keeps ONLY a column-scoped threshold update for authenticated/service_role.
  assert.ok(/GRANT UPDATE \(low_stock_threshold, updated_at\) ON TABLE public\.inventory/.test(sql), "inventory update is column-scoped to the threshold");
  // final lockdown: no authenticated EXECUTE on the atomic variant sync.
  assert.ok(/REVOKE EXECUTE ON FUNCTION public\.sync_product_variants\(uuid, jsonb\) FROM authenticated/.test(sql), "sync_product_variants revoked from authenticated");
});
