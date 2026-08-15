// Manual-Authority-Resolution — static guard for the one-time repair migration.
//
// Pins that the migration is a NARROW, safe, all-or-nothing repair of the ONE
// malformed authoritative variant (mk1550-1-bend, stock NULL): it sets that one
// variant's stock to the explicit operator-authorized literal, recomputes the
// parent rollup from Σ variants, writes an immutable audit trail — and NEVER
// touches sold, the retired mirror, availability, shelves, or the sales ledgers,
// never creates/replaces an RPC, and never weakens inv_set_variant_absolute.
//
// PURE — source scan only. Run:
// node --conditions=react-server --experimental-strip-types --test lib/inventory/manual-authority-resolution-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIG_DIR = join(ROOT, "supabase", "migrations");
const migFile = readdirSync(MIG_DIR).find((f) => /inventory_manual_authority_resolution\.sql$/.test(f));
const RAW = migFile ? readFileSync(join(MIG_DIR, migFile), "utf8") : "";
const CODE = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
const lc = CODE.toLowerCase();

const TARGET_VARIANT = "9c44f181-a263-4b2f-bb7f-6780f0773c18";
const TARGET_PRODUCT = "ce9f4962-716a-4acc-af90-62b8506ef298";
const PARENT_INV = "fb3b1750-cb6d-4d0a-97d4-3654ba10cbe2";

test("migration exists and is a transactional DO block", () => {
  assert.ok(migFile, "inventory_manual_authority_resolution.sql present");
  assert.ok(/do\s+\$\$/i.test(CODE) && /end\s+\$\$;/i.test(CODE), "wrapped in a DO $$ … END $$ block");
});

// ── only approved mutation targets ─────────────────────────────────────────────

test("mutates ONLY the target variant stock + parent inventory stock (+ audit)", () => {
  const updates = [...lc.matchAll(/update\s+(public\.)?([a-z_]+)\s+set\s+([^;]*)/g)].map((m) => ({ table: m[2], set: m[3] }));
  assert.ok(updates.length >= 2, "has the two approved UPDATEs");
  for (const u of updates) {
    assert.ok(["product_variants", "inventory"].includes(u.table), `unexpected UPDATE target: ${u.table}`);
    // both updates only touch stock_quantity (+ updated_at); never sold/availability.
    assert.ok(/stock_quantity/.test(u.set), "update sets stock_quantity");
    assert.equal(/sold_quantity|stock_status/.test(u.set), false, "update never touches sold_quantity/stock_status");
  }
  // INSERTs only into malak_audit.
  const inserts = [...lc.matchAll(/insert\s+into\s+(public\.)?([a-z_]+)/g)].map((m) => m[2]);
  for (const t of inserts) assert.equal(t, "malak_audit", `unexpected INSERT target: ${t}`);
});

test("operates on the exact target variant/product/parent only", () => {
  assert.ok(CODE.includes(TARGET_VARIANT), "target variant id present");
  assert.ok(CODE.includes(TARGET_PRODUCT), "target product id present");
  assert.ok(CODE.includes(PARENT_INV), "parent inventory id present");
  // The target variant id is bound to v_variant, and the product_variants UPDATE
  // is scoped to that single variable (id = v_variant), never a broad predicate.
  assert.ok(new RegExp(`v_variant\\s+uuid\\s*:=\\s*'${TARGET_VARIANT}'`, "i").test(CODE), "v_variant bound to the target variant id");
  const varUpdate = /update\s+product_variants\s+set[^;]*?where[^;]*?;/is.exec(CODE);
  assert.ok(varUpdate && /id\s*=\s*v_variant/i.test(varUpdate[0]), "variant UPDATE is scoped to id = v_variant");
});

test("requires target NULL precondition and an explicit non-negative literal", () => {
  assert.ok(/stock_quantity is null/i.test(CODE), "verifies target stock IS NULL before writing");
  assert.ok(/v_count\s+integer\s*:=\s*1\b/i.test(CODE), "explicit operator-authorized literal value (1)");
  assert.ok(/v_count is null or v_count < 0/i.test(lc), "validates the value is a non-negative integer");
});

test("recomputes the parent rollup from Σ variants (not a guess)", () => {
  assert.ok(/sum\(stock_quantity\)/i.test(CODE), "parent total derived from sum(variant stock)");
  assert.ok(/v_parent_total/.test(CODE), "uses computed parent total");
  assert.ok(/bigint/i.test(CODE) && /2147483647/.test(CODE), "computes in bigint + int4-safety check");
});

test("never writes sold, the retired mirror, availability, shelves, or the ledgers", () => {
  assert.equal(/set[^;]*sold_quantity/i.test(CODE), false, "never writes sold_quantity");
  assert.equal(/update\s+(public\.)?products\b/i.test(CODE), false, "never updates products (retired mirror)");
  assert.equal(/stock_status/i.test(CODE), false, "never touches availability");
  assert.equal(/update\s+(public\.)?shelf_stock\b|insert\s+into\s+(public\.)?shelf_stock\b|delete\s+from\s+(public\.)?shelf_stock\b/i.test(CODE), false, "no shelf_stock writes");
  assert.equal(/update\s+(public\.)?variant_shelf_stock\b|insert\s+into\s+(public\.)?variant_shelf_stock\b|delete\s+from\s+(public\.)?variant_shelf_stock\b/i.test(CODE), false, "no variant_shelf_stock writes");
  assert.equal(/shopify_synced_orders|talabat_orders|inv_sell|process_shopify|process_talabat|channel_mapping/i.test(CODE), false, "no sales/order/channel writes");
});

test("does not create a permanent RPC nor weaken inv_set_variant_absolute", () => {
  assert.equal(/create\s+(or\s+replace\s+)?function/i.test(CODE), false, "no CREATE FUNCTION (no permanent recovery RPC)");
  assert.equal(/inv_set_variant_absolute/i.test(CODE), false, "does not reference/alter inv_set_variant_absolute");
});

test("has deterministic locks, rowcount guards, and RAISE-based rollback", () => {
  assert.ok(/order by id for update/i.test(CODE), "variants/parent locked deterministically");
  assert.ok((lc.match(/get diagnostics v_rows = row_count/g) ?? []).length >= 2, "rowcount checked on both updates");
  assert.ok((lc.match(/raise exception/g) ?? []).length >= 8, "multiple RAISE guards (all-or-nothing)");
});

test("has an immutable audit trail with the right action/agent/semantics", () => {
  assert.ok(/'inventory_manual_authority'/.test(CODE), "action_type inventory_manual_authority");
  assert.ok(/system:manual-authority-resolution/.test(CODE), "agent tag");
  assert.ok(/'immutable',\s*true/.test(CODE), "audit rows immutable");
  assert.ok(/operator_authorized_normalization/.test(CODE), "source: operator_authorized_normalization (NOT a physical count)");
  assert.equal(/physical_stock_count/i.test(CODE), false, "never labels this a physical_stock_count");
  assert.ok(/resolve_null_authoritative_variant/.test(CODE), "variant audit reason");
  assert.ok(/parent_rollup_after_manual_authority/.test(CODE), "parent audit reason");
  assert.ok(/binary_in_stock_out_of_stock/.test(CODE), "records the binary authority mode");
  for (const f of ["variant_stock_quantity", "stock_quantity"]) {
    assert.ok(CODE.includes(`'${f}'`), `audit field ${f}`);
  }
});

test("has internal postconditions before commit", () => {
  assert.ok(/postcondition/i.test(CODE), "postcondition checks present");
  assert.ok(/parent stock <> .{0,4}variants|<> \(select sum/i.test(CODE), "re-verifies parent = Σ variants");
  assert.ok(/sold_quantity changed/i.test(CODE), "re-verifies sold unchanged");
});
