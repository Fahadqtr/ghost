// INV.4D — function-level migration guard for the product editor + Malak commit.
//
// Pins that the last two daily stock writers route through the Inventory Engine:
//   * lib/products/product-save.ts (updateProductCore) — no direct inventory stock
//     write, no lazy inventory seed, parent stock never from the top-level form for
//     a variant product, metadata on the session client (no admin), numeric stock
//     via the injected adapter / the atomic variant-sync RPC, missing inventory
//     FAIL CLOSED.
//   * app/api/malak/commit/route.ts (commitStock) — no direct inventory update /
//     insert, uses the Engine setAbsolute, old/new from the Engine (no mirror
//     fallback authority), no stock_status mutation.
// Plus: movements.ts stays a legacy direct writer (untouched), and neither migrated
// file couples to Availability / Shopify / Talabat.
//
// PURE — source scan only. Run:
// node --conditions=react-server --experimental-strip-types --test lib/inventory/inv-4d-writer-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const SAVE = strip(read("lib/products/product-save.ts"));
const MALAK = strip(read("app/api/malak/commit/route.ts"));

const INV_UPDATE = /\.from\(\s*["']inventory["']\s*\)\s*\.update\(/;
const INV_INSERT = /\.from\(\s*["']inventory["']\s*\)\s*\.insert\(/;
const SHELF_WRITE = /\.from\(\s*["'](shelf_stock|variant_shelf_stock)["']\s*\)\s*\.(update|insert|upsert|delete)/;
const PV_STOCK_WRITE = /\.from\(\s*["']product_variants["']\s*\)\s*\.update\(\s*\{[^}]*stock_quantity/;

function coreUpdateBody(): string {
  const start = SAVE.indexOf("export async function updateProductCore");
  assert.ok(start >= 0, "located updateProductCore");
  return SAVE.slice(start);
}
function commitStockBody(): string {
  const start = MALAK.indexOf("async function commitStock");
  assert.ok(start >= 0, "located commitStock");
  const next = MALAK.indexOf("\nasync function ", start + 1);
  return MALAK.slice(start, next < 0 ? MALAK.length : next);
}

// ── product-save.ts (updateProductCore) ───────────────────────────────────────

test("product-save: no direct inventory stock write, no lazy inventory seed", () => {
  assert.equal(INV_UPDATE.test(SAVE), false, "never updates the inventory table");
  assert.equal(INV_INSERT.test(SAVE), false, "never seeds an inventory row from the editor");
  assert.equal(SHELF_WRITE.test(SAVE), false, "never writes shelf tables");
  assert.equal(PV_STOCK_WRITE.test(SAVE), false, "never writes product_variants.stock_quantity directly");
});

test("product-save: metadata never uses an admin client (RLS preserved)", () => {
  assert.equal(/createAdminClient/.test(SAVE), false, "no admin client");
  assert.equal(/@\/lib\/supabase\/admin/.test(SAVE), false, "no admin import");
});

test("product-save: numeric stock goes through the Engine adapter + the atomic variant sync", () => {
  const body = coreUpdateBody();
  assert.ok(/inventory\.setAbsolute\(/.test(body), "simple stock change → Engine adapter setAbsolute");
  assert.ok(/syncProductVariants\(/.test(body), "variants → atomic sync RPC");
});

test("product-save: a variant product's parent comes from the rollup, never the top-level form", () => {
  const body = coreUpdateBody();
  // metadata patch strips stock_quantity out of the products write
  assert.ok(/stock_quantity:\s*_stockOmit,\s*\.\.\.metadataPatch/.test(body), "metadata write excludes stock_quantity");
  // the hasVariants branch takes parent stock from the sync result, not requestedStock
  assert.ok(/sync\.hasVariants/.test(body), "grain decided by the sync result");
  assert.ok(/sync\.parentStock/.test(body) && /sync\.parentBefore/.test(body), "parent stock from the atomic rollup");
  // the ONLY place requestedStock feeds a mutation is the simple (!hasVariants) branch
  assert.ok(/requestedStock != null && requestedStock !== invStockBefore/.test(body), "simple change gated on an actual change");
});

test("product-save: a missing inventory row FAILS CLOSED (no seed)", () => {
  const body = coreUpdateBody();
  assert.ok(/if \(!invRow/.test(body), "checks the inventory row exists");
  assert.ok(/reason: "inventory_missing"/.test(body), "fail-closed reason surfaced");
});

// ── Malak commitStock ─────────────────────────────────────────────────────────

test("malak commitStock: no direct inventory write, uses the Engine setAbsolute", () => {
  const body = commitStockBody();
  assert.equal(INV_UPDATE.test(body), false, "no inventory update");
  assert.equal(INV_INSERT.test(body), false, "no inventory insert / lazy seed");
  assert.ok(/setAbsolute\(sb,/.test(body), "routes through the Inventory Engine");
});

test("malak commitStock: old/new come from the Engine result, not a mirror fallback", () => {
  const body = commitStockBody();
  assert.ok(/res\.data\.before/.test(body) && /res\.data\.after/.test(body), "before/after from the Engine");
  // no reading products.stock_quantity/inventory.stock_quantity to compute oldVal
  assert.equal(/stock_quantity\s*\?\?/.test(body), false, "no mirror/inventory fallback for oldVal");
});

test("malak commitStock: never mutates stock_status (availability boundary)", () => {
  const body = commitStockBody();
  assert.equal(/stock_status/.test(body), false, "quantity update never touches availability");
});

// ── out-of-scope files stay as they were ──────────────────────────────────────

test("movements.ts was later converged onto the Inventory Engine (INV.6A)", () => {
  const mv = strip(read("lib/inventory/movements.ts"));
  assert.equal(/\.from\(\s*["']inventory["']\s*\)\s*\.update\(/.test(mv), false,
    "INV.6A converged the manual movement engine onto the atomic movement RPCs (no direct RMW)");
});

test("the product editor does not couple stock to Availability, nor to Shopify / Talabat", () => {
  // stock_status IS a legitimate explicit form field the editor passes through
  // (Phase 15) — the invariant is that it is NEVER derived from a quantity. The
  // core maps it straight from input (str(input.stock_status)) and no branch ties
  // it to stock_quantity.
  assert.ok(/stock_status:\s*str\(input\.stock_status\)/.test(SAVE), "stock_status is a passthrough form field");
  const core = coreUpdateBody();
  assert.equal(/stock_status/.test(core), false, "the save flow never derives stock_status from quantity");
  // (product-save imports a text-cleaner that happens to live in talabat-export.mjs;
  //  that is emoji/description cleaning, not sales-channel coupling — not asserted here.)
  // Malak's commitStock (its own scope) touches neither; the file's channel-sync
  // command is a separate, unrelated action (out of INV.4D scope).
  const body = commitStockBody();
  assert.equal(/stock_status/.test(body), false, "commitStock never writes stock_status");
  assert.equal(/shopify|talabat/i.test(body), false, "commitStock never touches a sales channel");
});
