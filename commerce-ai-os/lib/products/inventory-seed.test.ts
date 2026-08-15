// P1 — inventorySeed contract + adoption characterization. Pins the exact seed
// shape and proves the FOUR byte-for-byte-identical call sites adopted it while
// Staff and Shopify (whose seeds legitimately differ today) were left untouched.
//
// PURE — no DB, no network, no React. Reads source text for the adoption checks.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/inventory-seed.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { inventorySeed } from "./inventory-seed.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// ── contract ─────────────────────────────────────────────────────────────────

test("inventorySeed returns exactly the canonical shape", () => {
  assert.deepEqual(inventorySeed(12), {
    stock_quantity: 12,
    low_stock_threshold: 5,
    sold_quantity: 0,
  });
});

test("zero quantity", () => {
  assert.deepEqual(inventorySeed(0), { stock_quantity: 0, low_stock_threshold: 5, sold_quantity: 0 });
});

test("positive quantity flows through to stock_quantity only", () => {
  const s = inventorySeed(999);
  assert.equal(s.stock_quantity, 999);
  assert.equal(s.low_stock_threshold, 5);
  assert.equal(s.sold_quantity, 0);
});

test("threshold and sold are constant regardless of quantity", () => {
  for (const q of [0, 1, 5, 50, 1000]) {
    const s = inventorySeed(q);
    assert.equal(s.low_stock_threshold, 5);
    assert.equal(s.sold_quantity, 0);
  }
});

test("deterministic / pure — same input, equal (but fresh) output", () => {
  const a = inventorySeed(7);
  const b = inventorySeed(7);
  assert.deepEqual(a, b);
  assert.notEqual(a, b, "returns a fresh object each call (no shared mutable state)");
  a.stock_quantity = -1; // mutating one result must not affect another call
  assert.equal(inventorySeed(7).stock_quantity, 7);
});

test("only the three seed columns exist — no product_id (the caller adds it)", () => {
  assert.deepEqual(Object.keys(inventorySeed(3)).sort(), ["low_stock_threshold", "sold_quantity", "stock_quantity"]);
});

// ── the helper is pure: no framework / DB / React imports ─────────────────────

test("inventory-seed.ts has no @/ framework, DB, or React imports", () => {
  const src = read("lib/products/inventory-seed.ts");
  assert.equal(/from\s+["']@\//.test(src), false, "no @/ imports");
  assert.equal(/from\s+["'](react|next|@supabase)/.test(src), false, "no react/next/supabase imports");
  assert.equal(/createClient|createAdminClient/.test(src), false, "no DB client");
});

// ── INV.6B: NO runtime create path spreads inventorySeed directly anymore ──────
// After the strict lockdown, a client-side inventory INSERT is impossible for every
// role, so every create path delegates authoritative inventory to the service-role
// initializer (inv_initialize_product_state / inv_initialize_simple_products). The
// cores import only the pure VALIDATORS (isValidSeedQuantity / computeVariantParentSeed)
// from this module, never the row-shape builder. Each convergence is proven in its
// own suite (product-create / product-create-batch / malak / shopify / staff / batch-
// import-convergence). This guard pins that the direct-seed spread is fully retired.

const NO_DIRECT_SEED: string[] = [
  "lib/products/product-create.ts",
  "lib/products/product-create-batch.ts",
  "app/api/malak/commit/route.ts",
  "app/staff/actions.ts",
  "app/(app)/import-export/shopify-actions.ts",
  "app/(app)/import-export/snoonu-actions.ts",
  "app/(app)/import-export/pure-seoul-actions.ts",
];

for (const rel of NO_DIRECT_SEED) {
  test(`${rel} does not spread inventorySeed(...) — inventory goes through the service-role initializer`, () => {
    const src = read(rel);
    assert.equal(/\.\.\.inventorySeed\(/.test(src), false, `${rel} must not spread inventorySeed(...)`);
    assert.equal(/\.from\(\s*["']inventory["']\s*\)\s*\.insert\b/.test(src), false, `${rel} must not insert inventory directly`);
  });
}

// ── canonical seed-shape equivalence (the shape the initializer RPC must produce) ─
// Production defaults verified read-only: inventory.low_stock_threshold DEFAULT 5,
// inventory.sold_quantity DEFAULT 0. The inv_initialize_product_state RPC writes a
// row with exactly this shape (stock_quantity = seed, sold_quantity 0, threshold 5),
// so inventorySeed() remains the canonical TS reference for that persisted shape.

test("canonical seed shape: inventorySeed(7) is stock 7 / sold 0 / threshold 5", () => {
  const persisted = { product_id: "P", stock_quantity: 7, sold_quantity: 0, low_stock_threshold: 5 };
  assert.deepEqual({ product_id: "P", ...inventorySeed(7) }, persisted);
});

test("canonical seed shape: inventorySeed(42) is stock 42 / sold 0 / threshold 5", () => {
  const persisted = { product_id: "P", stock_quantity: 42, low_stock_threshold: 5, sold_quantity: 0 };
  assert.deepEqual({ product_id: "P", ...inventorySeed(42) }, persisted);
});
