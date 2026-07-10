// Tests for the low-stock flagging core.
// Run: node --experimental-strip-types --test lib/inventory/lowStock-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  computeLowStock,
  DEFAULT_LOW_THRESHOLD,
  type LowStockRow,
} from "./lowStock-compute.ts";

const row = (over: Partial<LowStockRow> & { products?: LowStockRow["products"] } = {}): LowStockRow => ({
  product_id: "p", stock_quantity: 0, low_stock_threshold: null, products: null, ...over,
});

test("a fresh store (every row still at the 50-unit seed) surfaces nothing", () => {
  const r = computeLowStock([row({ stock_quantity: 50 }), row({ stock_quantity: 50 })], 12);
  assert.deepEqual(r, { outCount: 0, lowCount: 0, items: [] });
});

test("once any row moves off the seed, flagging kicks in", () => {
  const r = computeLowStock([row({ stock_quantity: 50 }), row({ stock_quantity: 2 })], 12);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].stock, 2);
});

test("uses the default threshold when a row has none", () => {
  const belowDefault = computeLowStock([row({ stock_quantity: DEFAULT_LOW_THRESHOLD - 1 }), row({ stock_quantity: 3 })], 12);
  assert.equal(belowDefault.items.length, 2); // both <= 10
  const aboveDefault = computeLowStock([row({ stock_quantity: DEFAULT_LOW_THRESHOLD + 1 }), row({ stock_quantity: 3 })], 12);
  assert.equal(aboveDefault.items.length, 1); // 11 is above the default line
});

test("honors an explicit per-row threshold", () => {
  // stock 20 with threshold 25 is low; another row moves off the seed.
  const r = computeLowStock([row({ stock_quantity: 20, low_stock_threshold: 25 }), row({ stock_quantity: 3 })], 12);
  const hi = r.items.find((i) => i.stock === 20);
  assert.ok(hi, "stock-20 row should be flagged under its threshold of 25");
  assert.equal(hi!.threshold, 25);
});

test("out = stock <= 0, and outCount / lowCount split correctly", () => {
  const r = computeLowStock([
    row({ stock_quantity: 0 }),
    row({ stock_quantity: -2 }),
    row({ stock_quantity: 4 }),
  ], 12);
  assert.equal(r.outCount, 2); // 0 and -2
  assert.equal(r.lowCount, 1); // 4
  assert.ok(r.items.filter((i) => i.out).every((i) => i.stock <= 0));
});

test("orders out-of-stock first, then by lowest stock", () => {
  const r = computeLowStock([
    row({ product_id: "a", stock_quantity: 5 }),
    row({ product_id: "b", stock_quantity: 0 }),
    row({ product_id: "c", stock_quantity: 1 }),
  ], 12);
  assert.deepEqual(r.items.map((i) => i.productId), ["b", "c", "a"]);
});

test("simple In/Out mode flags ONLY out-of-stock — every available (qty 1) item is ignored", () => {
  // The bulk «متوفر» toggle sets available products to exactly 1; with a
  // threshold of 5 that used to flag the whole catalogue. Simple mode must
  // treat qty 1 as available and surface nothing when nothing is truly out.
  const available = computeLowStock([
    row({ product_id: "a", stock_quantity: 1, low_stock_threshold: 5 }),
    row({ product_id: "b", stock_quantity: 1, low_stock_threshold: 5 }),
  ], 12, true);
  assert.deepEqual(available, { outCount: 0, lowCount: 0, items: [] });

  const withOut = computeLowStock([
    row({ product_id: "a", stock_quantity: 1, low_stock_threshold: 5 }),
    row({ product_id: "b", stock_quantity: 0, low_stock_threshold: 5 }),
  ], 12, true);
  assert.equal(withOut.outCount, 1);
  assert.equal(withOut.lowCount, 0);
  assert.deepEqual(withOut.items.map((i) => i.productId), ["b"]);
});

test("caps the item list at the limit but keeps the full counts", () => {
  const rows: LowStockRow[] = [];
  for (let i = 0; i < 20; i++) rows.push(row({ product_id: `p${i}`, stock_quantity: 0 }));
  const r = computeLowStock(rows, 5);
  assert.equal(r.items.length, 5);
  assert.equal(r.outCount, 20); // counts reflect all flagged, not just the shown page
});

test("maps product fields with name_en → name_ar fallback", () => {
  const r = computeLowStock([
    row({ stock_quantity: 1, products: { name_en: null, name_ar: "كريم", sku: "MK9", image_url: "x.png" } }),
    row({ stock_quantity: 2 }),
  ], 12);
  const it = r.items.find((i) => i.sku === "MK9")!;
  assert.equal(it.name, "كريم"); // falls back to Arabic when English is missing
  assert.equal(it.nameAr, "كريم");
  assert.equal(it.image, "x.png");
});
