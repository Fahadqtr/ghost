// INV.4A — function-level migration guard for the product-grain writers.
//
// The repo-wide direct-write guard is file-level, and app/(app)/inventory/actions.ts
// legitimately stays legacy-direct (it still holds un-migrated variant + shelf
// writers for INV.4B/4C). This guard pins, at FUNCTION granularity, that the four
// INV.4A writers no longer write stock_quantity directly and route through the
// Inventory Engine — and that the NOT-yet-migrated writers still write directly
// (so a later phase can't silently regress them).
//
// PURE — source scan only. Run:
// node --conditions=react-server --experimental-strip-types --test lib/inventory/inv-4a-writer-guard.test.ts

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

// A direct stock_quantity mutation of the inventory table (what INV.4A removes).
const INV_STOCK_WRITE = /\.from\(\s*["']inventory["']\s*\)\s*\.update\(\s*\{[^}]*stock_quantity/;
// A direct variant stock_quantity mutation (owned by INV.4B — must NOT appear in 4A fns).
const PV_STOCK_WRITE = /\.from\(\s*["']product_variants["']\s*\)\s*\.update\(\s*\{[^}]*stock_quantity/;

const MIGRATED = ["updateInventory", "bulkUpdateInventory", "importInventoryBySku", "applyStocktake"] as const;

test("actions.ts imports the Inventory Engine + transition surfaces", () => {
  assert.ok(/from\s+["']@\/lib\/inventory\/engine["']/.test(ACTIONS), "imports engine");
  assert.ok(/\bsetAbsolute\b/.test(ACTIONS), "uses setAbsolute");
  assert.ok(/from\s+["']@\/lib\/inventory\/transition["']/.test(ACTIONS), "imports transition");
});

for (const name of MIGRATED) {
  test(`${name}: routes stock through engine.setAbsolute, no direct stock_quantity write`, () => {
    const body = fnBody(ACTIONS, name);
    assert.ok(body.length > 0, `located ${name}`);
    assert.ok(/setAbsolute\(/.test(body), `${name} calls setAbsolute`);
    assert.equal(INV_STOCK_WRITE.test(body), false, `${name} must not write inventory.stock_quantity directly`);
    assert.equal(PV_STOCK_WRITE.test(body), false, `${name} must not write product_variants.stock_quantity`);
  });
}

test("migrated functions do not couple to Availability", () => {
  for (const name of MIGRATED) {
    const body = fnBody(ACTIONS, name);
    assert.equal(/stock_status|setProductAvailability|writeProductAvailability|availabilityFromInStock/.test(body), false,
      `${name} must not touch availability`);
  }
});

// The stocktake path keeps exactly ONE stocktake audit (no double audit).
test("applyStocktake writes a single stocktake audit (action 'stocktake')", () => {
  const body = fnBody(ACTIONS, "applyStocktake");
  const stocktakeAudits = (body.match(/action:\s*["']stocktake["']/g) ?? []).length;
  assert.equal(stocktakeAudits, 1, "exactly one stocktake audit action label");
});

// The variant writers moved to the engine in INV.4B, the shelf writers in INV.4C
// (both pinned in detail by their own guards). This 4A guard only re-confirms the
// 4A functions here; the rest of the file is fully migrated.
test("the INV.4B variant + INV.4C shelf writers are no longer direct", () => {
  assert.equal(PV_STOCK_WRITE.test(fnBody(ACTIONS, "applyVariantStocktake")), false, "applyVariantStocktake migrated (INV.4B)");
  assert.equal(PV_STOCK_WRITE.test(fnBody(ACTIONS, "recordVariantMovement")), false, "recordVariantMovement migrated (INV.4B)");
  const shelfSave = fnBody(ACTIONS, "saveShelfStock");
  assert.equal(/\.from\(\s*["']shelf_stock["']\s*\)\s*\.(insert|update|upsert|delete)/.test(shelfSave), false, "saveShelfStock migrated to the engine (INV.4C)");
});
