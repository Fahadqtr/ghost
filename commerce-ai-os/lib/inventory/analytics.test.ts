// Tests for the pure inventory analytics (dead stock · margins · valuation).
// Run: node --conditions=react-server --experimental-strip-types --test lib/inventory/analytics.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { computeAnalytics, type AnalyticsRow } from "./analytics.ts";

function row(overrides: Partial<AnalyticsRow> = {}): AnalyticsRow {
  return {
    productId: "p1", sku: "mk1", name: "Cream", nameAr: "كريم", image: null,
    stock: 0, sold: 0, price: null, discountPrice: null, cost: null, ...overrides,
  };
}

test("dead stock = in stock with zero sales, ranked by tied-up money", () => {
  const a = computeAnalytics([
    row({ productId: "d1", stock: 5, sold: 0, price: 10, cost: 4 }),   // dead, tiedUp 20 (cost basis)
    row({ productId: "d2", stock: 2, sold: 0, price: 50 }),            // dead, no cost → price basis, 100
    row({ productId: "ok", stock: 9, sold: 3, price: 10 }),            // sells → not dead
    row({ productId: "oos", stock: 0, sold: 0, price: 10 }),           // no stock → not dead
  ]);
  assert.equal(a.deadStock.count, 2);
  assert.equal(a.deadStock.units, 7);
  assert.deepEqual(a.deadStock.items.map((i) => i.productId), ["d2", "d1"]); // 100 > 20
  assert.equal(a.deadStock.items[0].basis, "price");
  assert.equal(a.deadStock.items[1].basis, "cost");
  assert.equal(a.deadStock.tiedUpAtCost, 20);   // only d1 has a cost
  assert.equal(a.deadStock.tiedUpAtPrice, 150); // 5×10 + 2×50
});

test("margins: below-cost flagged, lowest-first ordering, coverage", () => {
  const a = computeAnalytics([
    row({ productId: "neg", price: 8, cost: 10, sold: 1, stock: 1 }),   // -2 → below cost
    row({ productId: "thin", price: 10, cost: 9, stock: 1 }),          // 10%
    row({ productId: "fat", price: 20, cost: 5, stock: 1 }),           // 75%
    row({ productId: "nocost", price: 15, stock: 1 }),                 // excluded from margins
  ]);
  assert.equal(a.margins.withCost, 3);
  assert.equal(a.margins.costCoveragePct, 75); // 3 of 4
  assert.deepEqual(a.margins.belowCost.map((m) => m.productId), ["neg"]);
  assert.equal(a.margins.belowCost[0].margin, -2);
  assert.deepEqual(a.margins.lowest.map((m) => m.productId), ["neg", "thin", "fat"]);
});

test("estimated profit uses sold units × (effective price − cost)", () => {
  const a = computeAnalytics([
    row({ productId: "a", sold: 10, price: 10, cost: 6, stock: 0 }),               // profit 40, revenue 100
    row({ productId: "b", sold: 5, price: 20, discountPrice: 15, cost: 10, stock: 0 }), // discount wins: 5×5=25, revenue 75
    row({ productId: "c", sold: 100, price: 9, stock: 0 }),                        // no cost → excluded
  ]);
  assert.equal(a.margins.estProfit, 65);
  assert.equal(a.margins.profitMarginPct, round2((65 / 175) * 100));
});

test("valuation totals stock at cost and at effective price", () => {
  const a = computeAnalytics([
    row({ stock: 10, price: 5, cost: 2 }),                    // atPrice 50, atCost 20
    row({ productId: "p2", stock: 4, price: 10, discountPrice: 8 }), // atPrice 32, no cost
  ]);
  assert.equal(a.valuation.skus, 2);
  assert.equal(a.valuation.units, 14);
  assert.equal(a.valuation.atPrice, 82);
  assert.equal(a.valuation.atCost, 20);
});

test("zero/invalid cost is treated as missing (no fake below-cost rows)", () => {
  const a = computeAnalytics([row({ stock: 1, price: 10, cost: 0 })]);
  assert.equal(a.margins.withCost, 0);
  assert.equal(a.margins.belowCost.length, 0);
});

test("empty input yields an all-zero report", () => {
  const a = computeAnalytics([]);
  assert.equal(a.deadStock.count, 0);
  assert.equal(a.valuation.units, 0);
  assert.equal(a.margins.costCoveragePct, 0);
  assert.equal(a.margins.profitMarginPct, 0);
});

function round2(n: number) { return Math.round(n * 100) / 100; }
