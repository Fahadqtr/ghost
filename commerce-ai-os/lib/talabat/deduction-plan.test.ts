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
});

test("6-pure: sumVariantStock is fail-closed — null/undefined sibling → null (never silently 0)", () => {
  for (const bad of [null, undefined, -1, 1.5, NaN, Infinity, -Infinity, "3" as unknown as number, true as unknown as number]) {
    assert.equal(sumVariantStock([{ stock_quantity: 2 }, { stock_quantity: bad }]), null, `bad=${String(bad)}`);
  }
  assert.equal(sumVariantStock([{ stock_quantity: 2 }, { stock_quantity: 3 }]), 5); // valid still sums
  assert.equal(sumVariantStock([{ stock_quantity: Number.MAX_SAFE_INTEGER }, { stock_quantity: 1 }]), null); // overflow
});

test("6-pure: spreadAcrossShelves is fail-closed for malformed values (null, never silently 0)", () => {
  assert.equal(spreadAcrossShelves([{ location: "A", quantity: -1 }], 1), null);
  assert.equal(spreadAcrossShelves([{ location: "A", quantity: 1.5 }], 1), null);
  assert.equal(spreadAcrossShelves([{ location: "A", quantity: NaN }], 1), null);
  assert.equal(spreadAcrossShelves([{ location: "A", quantity: Infinity }], 1), null);
  assert.equal(spreadAcrossShelves([{ location: "A", quantity: "3" as unknown as number }], 1), null);
  assert.equal(spreadAcrossShelves([{ location: "A", quantity: 3 }], 1.5), null);   // bad qty
  assert.equal(spreadAcrossShelves([{ location: "A", quantity: 3 }], -2), null);
  assert.deepEqual(spreadAcrossShelves([{ location: "A", quantity: 3 }], 2), [{ location: "A", deduct: 2 }]);
});

test("overflow: an aggregated quantity beyond the safe-integer range is invalid_plan", () => {
  const big = Number.MAX_SAFE_INTEGER;
  const plan = buildTalabatDeductionPlan(
    [{ masterProductId: "p2", masterVariantSku: "V-SKU", quantity: big }, { masterProductId: "p2", masterVariantSku: "V-SKU", quantity: big }],
    [variantStock({ variantStock: big })],
  );
  assert.equal(plan.status === "manual_review" && plan.reason, "invalid_plan");
});

test("shelf-spread-null: a malformed shelf value makes the target inventory_inconsistent", () => {
  const plan = buildTalabatDeductionPlan(
    [{ masterProductId: "p1", masterVariantSku: null, quantity: 1 }],
    [productStock({ inventoryStock: 3, shelves: [{ location: "A", quantity: 1.5 as unknown as number }, { location: "B", quantity: 1.5 as unknown as number }] })],
  );
  assert.equal(plan.status === "manual_review" && plan.reason, "inventory_inconsistent");
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

test("9-deep: nested raw / PII inside lines, targets and reasons is stripped", () => {
  const out = sanitizeResolution({
    lines: [{
      lineKey: "l0", status: "matched", via: "sku", quantity: 1,
      target: { masterProductId: "p", masterVariantSku: "s", raw: { x: 1 }, phone: "+974555111" },
      raw: { big: 1 }, customer: { phone: "+974555111", address: "Doha" }, token: "secret-1",
    }],
    targets: [{ masterProductId: "p", masterVariantSku: "s", quantity: 2, lineKeys: ["l0", { evil: 1 }], phone: "+974555111", token: "secret-2", raw: {}, authorization: "Bearer z" }],
    reasons: [{ lineKey: "l0", reason: "ambiguous_match", token: "secret-3", stack: "boom", sqlerrm: "err" }],
    lineKeys: ["l0", { evil: 1 }],
  });
  const l0 = (out.lines as any[])[0];
  assert.deepEqual(Object.keys(l0).sort(), ["lineKey", "quantity", "status", "target", "via"]);
  assert.deepEqual(Object.keys(l0.target).sort(), ["masterProductId", "masterVariantSku"]);
  const t0 = (out.targets as any[])[0];
  assert.deepEqual(Object.keys(t0).sort(), ["lineKeys", "masterProductId", "masterVariantSku", "quantity"]);
  assert.deepEqual(t0.lineKeys, ["l0"]); // non-string entries dropped
  assert.deepEqual(Object.keys((out.reasons as any[])[0]).sort(), ["lineKey", "reason"]);
  assert.deepEqual(out.lineKeys, ["l0"]);
  assert.ok(!/raw|customer|phone|token|stack|sqlerrm|authorization|Bearer|secret|555111|Doha|evil/i.test(JSON.stringify(out)), JSON.stringify(out));
});

test("1-scalar: an allowed key whose VALUE is a nested object/array is dropped (not preserved)", () => {
  const out = sanitizeResolution({
    lines: [{
      lineKey: { phone: "+974555", token: "secret" },      // allowed key, malicious object value
      status: ["x"],                                          // wrong type → dropped
      via: "sku",                                             // valid scalar → kept
      quantity: { raw: 1 },                                   // wrong type → dropped
      reason: 2,                                              // number where string expected → dropped
      target: { masterProductId: { token: "t" }, masterVariantSku: 5 }, // both wrong type → dropped
    }],
    targets: [{ masterProductId: { evil: 1 }, masterVariantSku: { phone: "x" }, quantity: "2", lineKeys: [{ t: 1 }, "ok"] }],
    reasons: [{ lineKey: { token: "z" }, reason: "ambiguous_match" }],
    reason: { nested: "bad" },                                // wrong type → dropped
    via: "sku",
  });
  assert.deepEqual((out.lines as any[])[0], { via: "sku", target: {} }); // only the valid scalar + empty target
  assert.deepEqual((out.targets as any[])[0], { lineKeys: ["ok"] });     // only the string lineKey survives
  assert.deepEqual((out.reasons as any[])[0], { reason: "ambiguous_match" });
  assert.equal(out.reason, undefined);                                    // nested object reason dropped
  assert.equal(out.via, "sku");
  assert.ok(!/phone|token|secret|evil|555|nested/i.test(JSON.stringify(out)), JSON.stringify(out));
});

test("manual-review payload carries only safe fields", () => {
  const payload = buildManualReviewPayload({ orderId: "o1", orderCode: "OC1", reason: "ambiguous_match", lineKeys: ["line-0"], candidates: [{ lineKey: "line-0", reason: "ambiguous_match", sku: "S1", barcode: "B1", channelProductId: "CP1" }] });
  assert.ok(!/phone|address|token|sqlerrm|\braw\b/i.test(JSON.stringify(payload)));
});
