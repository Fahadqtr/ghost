// Tests for the Shopify order → inventory deduction planner.
// Run: node --experimental-strip-types --test lib/shopify/order-deduct-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { planOrderDeductions, spreadDeduction, isVoidOrder, type OrderForDeduction, type CatalogRowLite } from "./order-deduct-compute.ts";

const CATALOG: CatalogRowLite[] = [
  { id: "p1", sku: "MK-1", name_en: "Rose Serum" },
  { id: "p2", sku: null, name_en: "Gold – Mask" },
];

const order = (over: Partial<OrderForDeduction>): OrderForDeduction => ({
  id: "gid://1", name: "#1001", financial: "PAID", cancelledAt: null,
  items: [{ title: "Rose Serum", qty: 1, sku: "mk-1" }],
  ...over,
});

test("matches by SKU then title, aggregates across orders", () => {
  const plan = planOrderDeductions(
    [
      order({}),
      order({ id: "gid://2", items: [{ title: "Whatever", qty: 2, sku: "MK-1" }, { title: "Gold Mask", qty: 1 }] }),
      order({ id: "gid://3", items: [{ title: "Unknown Thing", qty: 4 }] }),
    ],
    CATALOG,
    new Set(),
  );
  assert.deepEqual(plan.orderIds, ["gid://1", "gid://2", "gid://3"]);
  assert.deepEqual(plan.deductions.sort((a, b) => a.product_id.localeCompare(b.product_id)), [
    { product_id: "p1", name_en: "Rose Serum", qty: 3 },
    { product_id: "p2", name_en: "Gold – Mask", qty: 1 },
  ]);
  assert.deepEqual(plan.unmatched, [{ title: "Unknown Thing", qty: 4 }]);
});

test("already-synced orders are skipped entirely", () => {
  const plan = planOrderDeductions([order({})], CATALOG, new Set(["gid://1"]));
  assert.deepEqual(plan.orderIds, []);
  assert.deepEqual(plan.deductions, []);
});

test("cancelled/refunded orders are recorded but never deduct", () => {
  assert.equal(isVoidOrder({ financial: "REFUNDED", cancelledAt: null }), true);
  assert.equal(isVoidOrder({ financial: "PAID", cancelledAt: "2026-01-01" }), true);
  assert.equal(isVoidOrder({ financial: "PAID", cancelledAt: null }), false);

  const plan = planOrderDeductions([order({ financial: "REFUNDED" })], CATALOG, new Set());
  assert.deepEqual(plan.orderIds, ["gid://1"]); // marked synced → no re-processing
  assert.deepEqual(plan.deductions, []);
});

test("spreadDeduction drains biggest rows first and clamps at zero", () => {
  const updates = spreadDeduction(
    [{ rowKey: "a", stock: 2 }, { rowKey: "b", stock: 5 }],
    6,
  );
  assert.deepEqual(updates, [{ rowKey: "b", stock: 0 }, { rowKey: "a", stock: 1 }]);
  // more sold than we track → drain everything, never negative
  assert.deepEqual(spreadDeduction([{ rowKey: "a", stock: 1 }], 9), [{ rowKey: "a", stock: 0 }]);
  assert.deepEqual(spreadDeduction([], 3), []);
});
