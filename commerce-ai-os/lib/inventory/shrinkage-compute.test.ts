// Tests for the shrinkage aggregation core.
// Run: node --experimental-strip-types --test lib/inventory/shrinkage-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  computeShrinkage,
  productIdsIn,
  type ShrinkageRow,
} from "./shrinkage-compute.ts";

const row = (over: Partial<ShrinkageRow> & { details?: ShrinkageRow["details"] }): ShrinkageRow => ({
  sku: null, new_value: null, old_value: null, created_at: null, details: null, ...over,
});

test("sale rows count as sales, not loss", () => {
  const r = computeShrinkage([row({ details: { quantity: 5, reason: "sale" } })], 30);
  assert.equal(r.salesUnits, 5);
  assert.equal(r.lossUnits, 0);
  assert.equal(r.lossEvents, 0);
  assert.deepEqual(r.byReason, []);
});

test("transfers are excluded (Arabic and English, case-insensitive)", () => {
  const r = computeShrinkage([
    row({ details: { quantity: 3, reason: "تحويل" } }),
    row({ details: { quantity: 2, reason: "Transfer" } }),
  ], 30);
  assert.equal(r.lossUnits, 0);
  assert.equal(r.salesUnits, 0);
});

test("non-sale, non-transfer OUTs are loss and group by reason", () => {
  const r = computeShrinkage([
    row({ details: { quantity: 4, reason: "damaged" } }),
    row({ details: { quantity: 6, reason: "damaged" } }),
    row({ details: { quantity: 1, reason: "lost" } }),
  ], 30);
  assert.equal(r.lossUnits, 11);
  assert.equal(r.lossEvents, 3);
  assert.deepEqual(r.byReason, [
    { key: "damaged", units: 10, count: 2 }, // sorted by units desc
    { key: "lost", units: 1, count: 1 },
  ]);
});

test("quantity falls back to the ledger delta when details.quantity is absent", () => {
  const r = computeShrinkage([row({ new_value: 2, old_value: 10, details: { reason: "damaged" } })], 30);
  assert.equal(r.lossUnits, 8); // |2 - 10|
});

test("details.quantity wins over the delta when present", () => {
  const r = computeShrinkage([row({ new_value: 2, old_value: 10, details: { quantity: 3, reason: "damaged" } })], 30);
  assert.equal(r.lossUnits, 3);
});

test("zero / unusable quantities are skipped", () => {
  const r = computeShrinkage([
    row({ details: { quantity: 0, reason: "damaged" } }),
    row({ new_value: "x", old_value: "y", details: { reason: "damaged" } }), // NaN delta
  ], 30);
  assert.equal(r.lossEvents, 0);
  assert.equal(r.lossUnits, 0);
});

test("empty reason buckets under '—'", () => {
  const r = computeShrinkage([row({ details: { quantity: 2 } })], 30);
  assert.deepEqual(r.byReason, [{ key: "—", units: 2, count: 1 }]);
});

test("byEmployee strips the staff: prefix and groups", () => {
  const r = computeShrinkage([
    row({ details: { quantity: 2, reason: "damaged", by: "staff:sara" } }),
    row({ details: { quantity: 3, reason: "lost", by: "staff:sara" } }),
    row({ details: { quantity: 1, reason: "lost", by: "admin" } }),
  ], 30);
  assert.deepEqual(r.byEmployee, [
    { key: "sara", units: 5, count: 2 },
    { key: "admin", units: 1, count: 1 },
  ]);
});

test("byProduct keys by sku when there is no productId, and resolves names when provided", () => {
  const rows = [
    row({ sku: "MK1", details: { quantity: 4, reason: "damaged" } }),
    row({ details: { quantity: 2, reason: "damaged", productId: "p-9" } }),
  ];
  const names = new Map([["p-9", "Glow Serum"]]);
  const r = computeShrinkage(rows, 30, names);
  const keys = r.byProduct.map((p) => p.key);
  assert.ok(keys.includes("MK1"));       // sku fallback
  assert.ok(keys.includes("Glow Serum")); // resolved name for p-9
});

test("byProduct is capped at the top 10 by units", () => {
  const rows: ShrinkageRow[] = [];
  for (let i = 0; i < 15; i++) rows.push(row({ details: { quantity: i + 1, reason: "damaged", productId: `p${i}` } }));
  const r = computeShrinkage(rows, 30);
  assert.equal(r.byProduct.length, 10);
  assert.equal(r.byProduct[0].units, 15); // largest first
  assert.equal(r.byProduct[9].units, 6);  // 15..6 = top 10
});

test("productIdsIn returns the distinct product ids", () => {
  const ids = productIdsIn([
    row({ details: { productId: "a" } }),
    row({ details: { productId: "a" } }),
    row({ details: { productId: "b" } }),
    row({ sku: "no-id" }),
  ]);
  assert.deepEqual(ids.sort(), ["a", "b"]);
});

test("configured is always true and days is echoed", () => {
  const r = computeShrinkage([], 7);
  assert.equal(r.configured, true);
  assert.equal(r.days, 7);
});
