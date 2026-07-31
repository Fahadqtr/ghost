// Tests for the pure Talabat deduction planner + resolution whitelist. Fixtures
// only — NO Supabase, NO network.
// Run: node --conditions=react-server --experimental-strip-types --test lib/talabat/deduction-plan.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTalabatDeductionPlan,
  sumVariantStock,
  spreadAcrossShelves,
  sanitizeResolution,
  buildManualReviewPayload,
  type StockSnapshot,
} from "./deduction-plan.ts";

const variantStock = (over: Partial<Extract<StockSnapshot, { kind: "variant" }>> = {}): StockSnapshot => ({
  kind: "variant", masterProductId: "p2", masterVariantSku: "V-SKU", variantId: "vid-1", variantStock: 10, ...over,
});
const productStock = (over: Partial<Extract<StockSnapshot, { kind: "product" }>> = {}): StockSnapshot => ({
  kind: "product", masterProductId: "p1", inventoryId: "inv-1", inventoryStock: 10, ...over,
});

test("empty: an empty plan is never ready (invalid_plan)", () => {
  const plan = buildTalabatDeductionPlan([], []);
  assert.equal(plan.status, "manual_review");
  if (plan.status === "manual_review") assert.equal(plan.reason, "invalid_plan");
});

test("fractional quantity is rejected (invalid_plan, no floor)", () => {
  for (const q of [1.5, 0, -1, NaN]) {
    const plan = buildTalabatDeductionPlan([{ masterProductId: "p2", masterVariantSku: "V-SKU", quantity: q }], [variantStock()]);
    assert.equal(plan.status === "manual_review" && plan.reason, "invalid_plan", `qty ${q}`);
  }
});

test("6: duplicate targets are aggregated BEFORE the stock check", () => {
  // Variant A ×4 + Variant A ×4 = 8 required, only 5 available → insufficient.
  const plan = buildTalabatDeductionPlan(
    [{ masterProductId: "p2", masterVariantSku: "V-SKU", quantity: 4 }, { masterProductId: "p2", masterVariantSku: "V-SKU", quantity: 4 }],
    [variantStock({ variantStock: 5 })],
  );
  assert.equal(plan.status, "manual_review");
  if (plan.status === "manual_review") assert.equal(plan.reason, "insufficient_stock");
});

test("6b: duplicate targets that fit are aggregated into one deduction", () => {
  const plan = buildTalabatDeductionPlan(
    [{ masterProductId: "p2", masterVariantSku: "V-SKU", quantity: 2, lineKeys: ["l0"] }, { masterProductId: "p2", masterVariantSku: "V-SKU", quantity: 3, lineKeys: ["l1"] }],
    [variantStock({ variantStock: 10 })],
  );
  assert.equal(plan.status, "ready");
  if (plan.status === "ready") { assert.equal(plan.deductions.length, 1); assert.equal(plan.deductions[0].quantity, 5); }
});

test("18: insufficient stock blocks the whole order", () => {
  const plan = buildTalabatDeductionPlan([{ masterProductId: "p2", masterVariantSku: "V-SKU", quantity: 5 }], [variantStock({ variantStock: 3 })]);
  assert.equal(plan.status === "manual_review" && plan.reason, "insufficient_stock");
});

test("19: shelf spread totals the quantity and never goes negative", () => {
  const plan = buildTalabatDeductionPlan(
    [{ masterProductId: "p1", masterVariantSku: null, quantity: 7 }],
    [productStock({ inventoryStock: 7, shelves: [{ location: "A", quantity: 5 }, { location: "B", quantity: 2 }] })],
  );
  assert.equal(plan.status, "ready");
  if (plan.status === "ready") {
    assert.equal(plan.deductions[0].shelfPlan.reduce((s, d) => s + d.deduct, 0), 7);
    assert.ok(plan.deductions[0].shelfPlan.every((d) => d.deduct >= 0));
  }
  assert.deepEqual(spreadAcrossShelves([{ location: "A", quantity: 3 }], 3), [{ location: "A", deduct: 3 }]);
});

test("20/21: a variant target deducts the exact variant, never the generic parent", () => {
  const plan = buildTalabatDeductionPlan([{ masterProductId: "p2", masterVariantSku: "V-SKU", quantity: 2 }], [variantStock()]);
  assert.equal(plan.status, "ready");
  if (plan.status === "ready") { assert.equal(plan.deductions[0].masterVariantSku, "V-SKU"); assert.ok(plan.deductions.every((d) => d.masterVariantSku !== null)); }
});

test("22: inventory rollup uses SUM of variant stock (never max)", () => {
  assert.equal(sumVariantStock([{ stock_quantity: 2 }, { stock_quantity: 3 }, { stock_quantity: 0 }]), 5);
  assert.equal(sumVariantStock([{ stock_quantity: null }, { stock_quantity: 4 }]), 4);
});

test("5: a negative / non-integer stock value → inventory_inconsistent (not coerced to 0)", () => {
  assert.equal((buildTalabatDeductionPlan([{ masterProductId: "p2", masterVariantSku: "V-SKU", quantity: 1 }], [variantStock({ variantStock: -3 })]) as any).reason, "inventory_inconsistent");
  assert.equal((buildTalabatDeductionPlan([{ masterProductId: "p2", masterVariantSku: "V-SKU", quantity: 1 }], [variantStock({ variantStock: 2.5 as unknown as number })]) as any).reason, "inventory_inconsistent");
});

test("5b: a duplicate stock snapshot for one target → inventory_inconsistent", () => {
  const plan = buildTalabatDeductionPlan([{ masterProductId: "p2", masterVariantSku: "V-SKU", quantity: 1 }], [variantStock(), variantStock({ variantStock: 99 })]);
  assert.equal(plan.status === "manual_review" && plan.reason, "inventory_inconsistent");
});

test("inconsistent: variant stock vs shelf-sum mismatch → inventory_inconsistent", () => {
  const plan = buildTalabatDeductionPlan([{ masterProductId: "p2", masterVariantSku: "V-SKU", quantity: 1 }], [variantStock({ variantStock: 10, shelves: [{ location: "A", quantity: 4 }] })]);
  assert.equal(plan.status === "manual_review" && plan.reason, "inventory_inconsistent");
});

test("missing snapshot / wrong kind → inventory_inconsistent", () => {
  assert.equal(buildTalabatDeductionPlan([{ masterProductId: "pX", masterVariantSku: "S", quantity: 1 }], []).status, "manual_review");
  const bad = buildTalabatDeductionPlan([{ masterProductId: "p1", masterVariantSku: "S", quantity: 1 }], [productStock({ masterProductId: "p1" })]);
  assert.equal(bad.status === "manual_review" && bad.reason, "inventory_inconsistent");
});

test("9: sanitizeResolution keeps only whitelisted keys (drops raw/customer/token/errors)", () => {
  const out = sanitizeResolution({
    lines: [1], targets: [2], lineKeys: ["l0"], reason: "x", reasons: [], via: "sku",
    raw: { big: 1 }, customer: { phone: "123" }, token: "secret", authorization: "Bearer x", sqlerrm: "boom", headers: {},
  });
  assert.deepEqual(Object.keys(out).sort(), ["lineKeys", "lines", "reason", "reasons", "targets", "via"]);
  assert.ok(!/secret|123|boom|Bearer/.test(JSON.stringify(out)));
});

test("manual-review payload carries only safe fields", () => {
  const payload = buildManualReviewPayload({ orderId: "o1", orderCode: "OC1", reason: "ambiguous_match", lineKeys: ["line-0"], candidates: [{ lineKey: "line-0", reason: "ambiguous_match", sku: "S1", barcode: "B1", channelProductId: "CP1" }] });
  assert.ok(!/phone|address|token|sqlerrm|\braw\b/i.test(JSON.stringify(payload)));
});
