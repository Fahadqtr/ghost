// Tests for the pure Talabat deduction planner + manual-review payload. Fixtures
// only — NO Supabase, NO network.
// Run: node --conditions=react-server --experimental-strip-types --test lib/talabat/deduction-plan.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTalabatDeductionPlan,
  sumVariantStock,
  spreadAcrossShelves,
  buildManualReviewPayload,
  type StockSnapshot,
} from "./deduction-plan.ts";

const variantStock = (over: Partial<Extract<StockSnapshot, { kind: "variant" }>> = {}): StockSnapshot => ({
  kind: "variant", masterProductId: "p2", masterVariantSku: "V-SKU", variantId: "vid-1", variantStock: 10, ...over,
});
const productStock = (over: Partial<Extract<StockSnapshot, { kind: "product" }>> = {}): StockSnapshot => ({
  kind: "product", masterProductId: "p1", inventoryId: "inv-1", inventoryStock: 10, ...over,
});

test("18: insufficient stock blocks the whole order (manual_review, no deductions)", () => {
  const plan = buildTalabatDeductionPlan(
    [{ masterProductId: "p2", masterVariantSku: "V-SKU", quantity: 5 }],
    [variantStock({ variantStock: 3 })],
  );
  assert.equal(plan.status, "manual_review");
  if (plan.status === "manual_review") assert.equal(plan.reason, "insufficient_stock");
});

test("18b: one short target blocks EVERY target (all-or-nothing)", () => {
  const plan = buildTalabatDeductionPlan(
    [{ masterProductId: "p2", masterVariantSku: "V-SKU", quantity: 1 }, { masterProductId: "p1", masterVariantSku: null, quantity: 99 }],
    [variantStock({ variantStock: 10 }), productStock({ inventoryStock: 2 })],
  );
  assert.equal(plan.status, "manual_review"); // the p1 shortfall blocks the p2 deduction too
});

test("19: deductions never exceed available; shelf spread never goes negative", () => {
  const plan = buildTalabatDeductionPlan(
    [{ masterProductId: "p1", masterVariantSku: null, quantity: 7 }],
    [productStock({ inventoryStock: 7, shelves: [{ location: "A", quantity: 5 }, { location: "B", quantity: 2 }] })],
  );
  assert.equal(plan.status, "ready");
  if (plan.status === "ready") {
    const total = plan.deductions[0].shelfPlan.reduce((s, d) => s + d.deduct, 0);
    assert.equal(total, 7);
    assert.ok(plan.deductions[0].shelfPlan.every((d) => d.deduct >= 0));
  }
  // spreadAcrossShelves caps at what each shelf has (never negative).
  assert.deepEqual(spreadAcrossShelves([{ location: "A", quantity: 3 }], 3), [{ location: "A", deduct: 3 }]);
});

test("20: a variant target deducts the exact variant", () => {
  const plan = buildTalabatDeductionPlan([{ masterProductId: "p2", masterVariantSku: "V-SKU", quantity: 2 }], [variantStock()]);
  assert.equal(plan.status, "ready");
  if (plan.status === "ready") {
    assert.equal(plan.deductions.length, 1);
    assert.equal(plan.deductions[0].masterVariantSku, "V-SKU");
    assert.equal(plan.deductions[0].quantity, 2);
  }
});

test("21: a variant target never becomes a generic parent deduction", () => {
  const plan = buildTalabatDeductionPlan([{ masterProductId: "p2", masterVariantSku: "V-SKU", quantity: 2 }], [variantStock()]);
  assert.equal(plan.status, "ready");
  if (plan.status === "ready") {
    assert.ok(plan.deductions.every((d) => d.masterVariantSku !== null), "no null-variant (parent) deduction for a variant target");
  }
});

test("22: inventory rollup uses the SUM of variant stock (never max)", () => {
  assert.equal(sumVariantStock([{ stock_quantity: 2 }, { stock_quantity: 3 }, { stock_quantity: 0 }]), 5);
  assert.equal(sumVariantStock([{ stock_quantity: null }, { stock_quantity: 4 }]), 4);
});

test("inconsistent: variant stock vs shelf sum mismatch → inventory_inconsistent", () => {
  const plan = buildTalabatDeductionPlan(
    [{ masterProductId: "p2", masterVariantSku: "V-SKU", quantity: 1 }],
    [variantStock({ variantStock: 10, shelves: [{ location: "A", quantity: 4 }] })], // 4 != 10
  );
  assert.equal(plan.status, "manual_review");
  if (plan.status === "manual_review") assert.equal(plan.reason, "inventory_inconsistent");
});

test("missing snapshot / wrong kind → inventory_inconsistent (no deduction)", () => {
  assert.equal(buildTalabatDeductionPlan([{ masterProductId: "pX", masterVariantSku: "S", quantity: 1 }], []).status, "manual_review");
  // variant target given a product snapshot
  const bad = buildTalabatDeductionPlan([{ masterProductId: "p1", masterVariantSku: "S", quantity: 1 }], [productStock({ masterProductId: "p1" })]);
  assert.equal(bad.status === "manual_review" && bad.reason, "inventory_inconsistent");
});

test("manual-review payload carries only safe fields (no raw/phone/token/DB error)", () => {
  const payload = buildManualReviewPayload({
    orderId: "o1", orderCode: "OC1", reason: "ambiguous_match",
    lineKeys: ["line-0"],
    candidates: [{ lineKey: "line-0", reason: "ambiguous_match", sku: "S1", barcode: "B1", channelProductId: "CP1" }],
  });
  const json = JSON.stringify(payload);
  assert.equal((payload as any).kind, "talabat_review");
  assert.ok(!/phone|address|token|sqlerrm|raw/i.test(json), `payload leaked a forbidden field: ${json}`);
});
