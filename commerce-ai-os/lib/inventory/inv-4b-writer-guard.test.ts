// INV.4B — function-level migration guard for the variant movement writers.
//
// The repo-wide direct-write guard is file-level, and both
// app/(app)/inventory/actions.ts and app/staff/actions.ts legitimately stay
// legacy-direct (shelf writers await INV.4C; staff keeps an inventory-row seed).
// This guard pins, at FUNCTION granularity, that the three INV.4B writers no
// longer write variant stock / parent rollup / sold_quantity directly and route
// through the Inventory Engine + authoritative transition — and that the shelf
// writers in the same file stay direct (so INV.4C is still a visible change).
//
// PURE — source scan only. Run:
// node --conditions=react-server --experimental-strip-types --test lib/inventory/inv-4b-writer-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const INV_ACTIONS = readFileSync(join(ROOT, "app/(app)/inventory/actions.ts"), "utf8");
const STAFF_ACTIONS = readFileSync(join(ROOT, "app/staff/actions.ts"), "utf8");

function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  if (start < 0) return "";
  const after = src.indexOf("\nexport ", start + 1);
  return code(src.slice(start, after < 0 ? src.length : after));
}

// Direct numeric writes the INV.4B functions must NO LONGER perform.
const PV_STOCK_WRITE = /\.from\(\s*["']product_variants["']\s*\)\s*\.update\(\s*\{[^}]*stock_quantity/;
const INV_WRITE = /\.from\(\s*["']inventory["']\s*\)\s*\.(update|insert|upsert)/;
// A direct sold_quantity mutation via an inventory update payload.
const SOLD_WRITE = /\.from\(\s*["']inventory["']\s*\)\s*\.update\(\s*\{[^}]*sold_quantity/;

// ── imports present ───────────────────────────────────────────────────────────

test("inventory actions import the variant Engine + authoritative transition", () => {
  assert.ok(/from\s+["']@\/lib\/inventory\/engine["']/.test(INV_ACTIONS), "imports engine");
  assert.ok(/\bsetVariantAbsolute\b/.test(INV_ACTIONS) && /\badjustVariantMovement\b/.test(INV_ACTIONS), "uses variant engine ops");
  assert.ok(/logAuthoritativeVariantTransition/.test(INV_ACTIONS), "imports authoritative transition");
});

test("staff actions import the variant Engine + authoritative transition", () => {
  assert.ok(/from\s+["']@\/lib\/inventory\/engine["']/.test(STAFF_ACTIONS), "imports engine");
  assert.ok(/\badjustVariantMovement\b/.test(STAFF_ACTIONS), "uses adjustVariantMovement");
  assert.ok(/logAuthoritativeVariantTransition/.test(STAFF_ACTIONS), "imports authoritative transition");
});

// ── recordVariantMovement ─────────────────────────────────────────────────────

test("recordVariantMovement: engine movement, no direct variant/parent/sold write", () => {
  const body = fnBody(INV_ACTIONS, "recordVariantMovement");
  assert.ok(body.length > 0, "located recordVariantMovement");
  assert.ok(/adjustVariantMovement\(/.test(body), "routes through adjustVariantMovement");
  assert.equal(PV_STOCK_WRITE.test(body), false, "no direct product_variants.stock_quantity write");
  assert.equal(INV_WRITE.test(body), false, "no direct inventory write (parent rollup / sold via RPC)");
  assert.equal(SOLD_WRITE.test(body), false, "no direct sold_quantity write");
  assert.ok(/logAuthoritativeVariantTransition\(/.test(body), "uses authoritative transition");
  assert.equal(/logStockTransition\(/.test(body), false, "does not use the product-grain transition");
  // audit semantics preserved: stock_in / stock_out on field variant_stock_quantity.
  assert.ok(/action:\s*input\.type === "in" \? "stock_in" : "stock_out"/.test(body) || /"stock_in"/.test(body) && /"stock_out"/.test(body), "stock_in/stock_out audit action preserved");
  assert.ok(/variant_stock_quantity/.test(body), "audit field preserved");
  // sale semantics: soldDelta = qty only for a sale-out.
  assert.ok(/reason[^\n]*sale/.test(body) && /soldDelta/.test(body), "sale → soldDelta mapping present");
});

// ── applyVariantStocktake ─────────────────────────────────────────────────────

test("applyVariantStocktake: engine setVariantAbsolute, no direct write, no manual rollup", () => {
  const body = fnBody(INV_ACTIONS, "applyVariantStocktake");
  assert.ok(body.length > 0, "located applyVariantStocktake");
  assert.ok(/setVariantAbsolute\(/.test(body), "routes through setVariantAbsolute");
  assert.equal(PV_STOCK_WRITE.test(body), false, "no direct product_variants.stock_quantity write");
  assert.equal(INV_WRITE.test(body), false, "no manual parent inventory rollup write");
  // a single stocktake audit, only on an actual change.
  const stocktakeAudits = (body.match(/action:\s*["']stocktake["']/g) ?? []).length;
  assert.equal(stocktakeAudits, 1, "exactly one stocktake audit action label");
  assert.ok(/if \(after !== before\)/.test(body), "audit + transition only when the value changed (no no-op audit)");
  assert.ok(/logAuthoritativeVariantTransition\(/.test(body), "uses authoritative transition");
  // uses the derived parentBefore from the engine result.
  assert.ok(/parentBefore/.test(body), "reads the engine's parentBefore");
});

// ── staffMoveVariant ──────────────────────────────────────────────────────────

test("staffMoveVariant: engine movement (soldDelta 0), audit + transition preserved", () => {
  const body = fnBody(STAFF_ACTIONS, "staffMoveVariant");
  assert.ok(body.length > 0, "located staffMoveVariant");
  assert.ok(/adjustVariantMovement\(/.test(body), "routes through adjustVariantMovement");
  assert.ok(/soldDelta:\s*0/.test(body), "staff moves carry no sale/sold semantics");
  assert.equal(PV_STOCK_WRITE.test(body), false, "no direct product_variants.stock_quantity write");
  assert.equal(INV_WRITE.test(body), false, "no direct inventory write");
  assert.equal(SOLD_WRITE.test(body), false, "no direct sold_quantity write");
  // audit label preserved EXACTLY (approvals queue depends on variant_stock_in/out).
  assert.ok(/variant_stock_in/.test(body) && /variant_stock_out/.test(body), "variant_stock_in/out audit preserved");
  assert.equal(/"stock_in"|"stock_out"/.test(body), false, "not downgraded to product stock_in/out");
  assert.ok(/logAuthoritativeVariantTransition\(/.test(body), "uses authoritative transition");
  assert.equal(/logVariantStockTransition\(/.test(body), false, "no longer uses the legacy variant transition");
});

// ── the shelf writers migrated in INV.4C (pinned by inv-4c-writer-guard) ───────

test("shelf writers no longer write shelf tables directly (migrated in INV.4C)", () => {
  const shelfSave = fnBody(INV_ACTIONS, "saveShelfStock");
  assert.equal(/\.from\(\s*["']shelf_stock["']\s*\)\s*\.(insert|update|upsert|delete)/.test(shelfSave), false, "saveShelfStock routes through the engine (INV.4C)");
});
