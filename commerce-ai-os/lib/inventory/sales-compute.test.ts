// Tests for the sales aggregation core.
// Run: node --experimental-strip-types --test lib/inventory/sales-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { computeSalesSummary, type SalesRow } from "./sales-compute.ts";

const row = (over: Partial<SalesRow> & { products?: SalesRow["products"] } = {}): SalesRow => ({
  product_id: "p", sold_quantity: 0, products: null, ...over,
});

test("sums units and revenue over rows that actually sold", () => {
  const r = computeSalesSummary([
    row({ sold_quantity: 2, products: { price: 10 } }),
    row({ sold_quantity: 3, products: { price: 5 } }),
  ], 10);
  assert.equal(r.totalUnits, 5);
  assert.equal(r.totalRevenue, 2 * 10 + 3 * 5);
  assert.equal(r.distinctProducts, 2);
});

test("rows with zero or missing sold_quantity are excluded", () => {
  const r = computeSalesSummary([
    row({ sold_quantity: 0, products: { price: 10 } }),
    row({ sold_quantity: null, products: { price: 10 } }),
    row({ sold_quantity: 4, products: { price: 2 } }),
  ], 10);
  assert.equal(r.distinctProducts, 1);
  assert.equal(r.totalUnits, 4);
  assert.equal(r.totalRevenue, 8);
});

test("discount price wins over list price for revenue", () => {
  const r = computeSalesSummary([row({ sold_quantity: 2, products: { price: 10, discount_price: 7 } })], 10);
  assert.equal(r.topByUnits[0].price, 7);
  assert.equal(r.totalRevenue, 14);
});

test("falls back to list price when there is no discount", () => {
  const r = computeSalesSummary([row({ sold_quantity: 2, products: { price: 9, discount_price: null } })], 10);
  assert.equal(r.topByUnits[0].price, 9);
});

test("missing price is treated as 0 revenue (unit still counts)", () => {
  const r = computeSalesSummary([row({ sold_quantity: 3, products: {} })], 10);
  assert.equal(r.totalUnits, 3);
  assert.equal(r.totalRevenue, 0);
  assert.equal(r.topByUnits[0].revenue, 0);
});

test("topByUnits and topByRevenue rank independently", () => {
  // A: many cheap units; B: few expensive units → different leaders.
  const rows = [
    row({ product_id: "A", sold_quantity: 100, products: { price: 1 } }),   // 100 units, 100 revenue
    row({ product_id: "B", sold_quantity: 5, products: { price: 50 } }),    // 5 units, 250 revenue
  ];
  const r = computeSalesSummary(rows, 10);
  assert.equal(r.topByUnits[0].productId, "A");
  assert.equal(r.topByRevenue[0].productId, "B");
});

test("each best-seller list is capped at topN", () => {
  const rows: SalesRow[] = [];
  for (let i = 0; i < 12; i++) rows.push(row({ product_id: `p${i}`, sold_quantity: i + 1, products: { price: 1 } }));
  const r = computeSalesSummary(rows, 5);
  assert.equal(r.topByUnits.length, 5);
  assert.equal(r.topByRevenue.length, 5);
  assert.equal(r.distinctProducts, 12); // full count, not just the shown page
  assert.equal(r.topByUnits[0].units, 12); // largest first
});

test("maps product fields with name_en → name_ar fallback", () => {
  const r = computeSalesSummary([
    row({ sold_quantity: 1, products: { name_en: null, name_ar: "كريم", sku: "MK9", image_url: "x.png", price: 1 } }),
  ], 10);
  const it = r.topByUnits[0];
  assert.equal(it.name, "كريم");
  assert.equal(it.nameAr, "كريم");
  assert.equal(it.sku, "MK9");
  assert.equal(it.image, "x.png");
});
