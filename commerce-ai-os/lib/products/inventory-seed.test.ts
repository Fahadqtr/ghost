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

// ── adoption: the four byte-identical sites now spread inventorySeed ───────────

const ADOPTED: [string, string][] = [
  ["lib/products/product-create.ts", "createProductCore"],
  ["app/api/malak/commit/route.ts", "Malak commit"],
  ["app/(app)/import-export/snoonu-actions.ts", "Snoonu import"],
  ["app/(app)/import-export/pure-seoul-actions.ts", "Pure Seoul import"],
];

for (const [rel, name] of ADOPTED) {
  test(`${name} adopted inventorySeed`, () => {
    const src = read(rel);
    // `./inventory-seed.ts` (core, extensioned) or `@/lib/products/inventory-seed` (server files).
    assert.ok(/from\s+["'][^"']*inventory-seed(?:\.ts)?["']/.test(src), `${rel} imports inventory-seed`);
    assert.ok(/\.\.\.inventorySeed\(/.test(src), `${rel} spreads inventorySeed(...)`);
  });
}

// ── intentionally NOT changed (their seeds legitimately differ — P3 territory) ─

test("Staff seed is intentionally untouched (still omits low_stock_threshold)", () => {
  const src = read("app/staff/actions.ts");
  assert.equal(/inventorySeed\(/.test(src), false, "Staff does not use inventorySeed yet");
  assert.ok(
    /insert\(\{\s*product_id:\s*id,\s*stock_quantity:\s*stock,\s*sold_quantity:\s*0\s*\}\)/.test(src),
    "Staff seed shape unchanged (no low_stock_threshold)",
  );
});

test("Shopify import seed is intentionally untouched (only product_id + stock_quantity)", () => {
  const src = read("app/(app)/import-export/shopify-actions.ts");
  assert.equal(/inventorySeed\(/.test(src), false, "Shopify does not use inventorySeed yet");
  assert.ok(
    /insert\(\{\s*product_id:\s*ins\.id,\s*stock_quantity:\s*qty\s*\}\)/.test(src),
    "Shopify seed shape unchanged (no threshold / sold_quantity)",
  );
});
