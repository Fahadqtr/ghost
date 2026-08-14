// INV.4C — function-level migration guard for the shelf writers.
//
// Pins, at FUNCTION granularity, that every shelf/location writer routes through the
// Inventory Engine and performs NO direct write to shelf_stock / variant_shelf_stock
// / product_variants.stock_quantity / inventory (stock or location) — and that the
// topology deletions (deleteSlot / deleteShelf) are fail-closed (reject an occupied
// slot; never auto-delete placements).
//
// PURE — source scan only. Run:
// node --conditions=react-server --experimental-strip-types --test lib/inventory/inv-4c-writer-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ACTIONS = readFileSync(join(ROOT, "app/(app)/inventory/actions.ts"), "utf8");

function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  if (start < 0) return "";
  const after = src.indexOf("\nexport ", start + 1);
  return code(src.slice(start, after < 0 ? src.length : after));
}

const SHELF_TABLE_WRITE = /\.from\(\s*["'](shelf_stock|variant_shelf_stock)["']\s*\)\s*\.(update|insert|upsert|delete)/;
const INV_WRITE_ANY = /\.from\(\s*["']inventory["']\s*\)\s*\.(update|insert|upsert|delete)/;
const PV_STOCK_WRITE = /\.from\(\s*["']product_variants["']\s*\)\s*\.update\(\s*\{[^}]*stock_quantity/;

// writer → the engine op it must call
const MIGRATED: Record<string, RegExp> = {
  setLocation: /assignFullShelf\(/,
  applyShelfCounts: /placeOnShelf\(/,
  saveShelfStock: /replaceShelfDistribution\(/,
  saveVariantShelfStock: /replaceShelfDistribution\(/,
  removeFromShelf: /removeShelf\(/,
  moveShelfStock: /moveShelf\(/,
  bulkAssignShelf: /assignFullShelf\(/,
  bulkAssignVariantShelf: /assignFullShelf\(/,
};

test("inventory actions import the shelf Engine ops + authoritative transitions", () => {
  assert.ok(/from\s+["']@\/lib\/inventory\/engine["']/.test(ACTIONS), "imports engine");
  for (const op of ["placeOnShelf", "removeShelf", "replaceShelfDistribution", "assignFullShelf", "moveShelf"]) {
    assert.ok(new RegExp(`\\b${op}\\b`).test(ACTIONS), `uses ${op}`);
  }
  assert.ok(/logAuthoritativeStockTransition/.test(ACTIONS), "imports authoritative product transition");
});

for (const [name, engineCall] of Object.entries(MIGRATED)) {
  test(`${name}: routes through the Engine, no direct shelf/stock/location write`, () => {
    const body = fnBody(ACTIONS, name);
    assert.ok(body.length > 0, `located ${name}`);
    assert.ok(engineCall.test(body), `${name} calls the expected Engine op`);
    assert.equal(SHELF_TABLE_WRITE.test(body), false, `${name} must not write shelf_stock / variant_shelf_stock`);
    assert.equal(INV_WRITE_ANY.test(body), false, `${name} must not write the inventory table directly`);
    assert.equal(PV_STOCK_WRITE.test(body), false, `${name} must not write product_variants.stock_quantity`);
  });
}

test("shelf writers do not couple to Availability", () => {
  for (const name of Object.keys(MIGRATED)) {
    const body = fnBody(ACTIONS, name);
    assert.equal(/stock_status|setProductAvailability|writeProductAvailability|setVariantAvailability/.test(body), false,
      `${name} must not touch availability`);
  }
});

// ── topology deletions: fail-closed, no placement auto-delete ──────────────────

for (const name of ["deleteSlot", "deleteShelf"]) {
  test(`${name}: fail-closed topology delete (no placement/location writes)`, () => {
    const body = fnBody(ACTIONS, name);
    assert.ok(body.length > 0, `located ${name}`);
    // never deletes placements or clears inventory.location
    assert.equal(SHELF_TABLE_WRITE.test(body), false, `${name} must not delete shelf placements`);
    assert.equal(INV_WRITE_ANY.test(body), false, `${name} must not clear inventory.location`);
    // reads BOTH overlays to check occupancy, and refuses when occupied
    assert.ok(/from\(\s*["']shelf_stock["']\s*\)/.test(body), `${name} checks shelf_stock occupancy`);
    assert.ok(/from\(\s*["']variant_shelf_stock["']\s*\)/.test(body), `${name} checks variant_shelf_stock occupancy`);
    assert.ok(/return \{ error:/.test(body), `${name} returns a fail-closed error when occupied`);
    // still deletes the topology row (shelf_slots) — that is allowed
    assert.ok(/from\(\s*["']shelf_slots["']\s*\)\s*\.delete/.test(body), `${name} deletes the empty shelf_slots row`);
  });
}