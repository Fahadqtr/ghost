// Tests for the pure Talabat order resolver (matching ladder + aggregation +
// all-or-nothing). Fixtures only — NO Supabase, NO network.
// Run: node --conditions=react-server --experimental-strip-types --test lib/talabat/order-resolver.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { resolveLine, resolveTalabatOrder, type ResolveContext, type ResolverLine } from "./order-resolver.ts";

function ctx(over: Partial<ResolveContext> = {}): ResolveContext {
  return {
    mappings: [
      { channelProductId: "CP-1", exportedSku: "V-SKU", exportedBarcode: "V-BC", masterProductId: "p2", masterVariantSku: "V-SKU", mappingStatus: "active" },
    ],
    products: [
      { id: "p1", sku: "PSKU", barcode: "PBC", title: "Prod One" },
      { id: "p2", sku: null, barcode: null, title: "Prod Two" },
    ],
    variants: [
      { parentProductId: "p2", sku: "V-SKU", barcode: "V-BC" },
    ],
    ...over,
  };
}
const line = (over: Partial<ResolverLine>): ResolverLine => ({ lineKey: "line-0", channelProductId: null, sku: null, barcode: null, title: null, quantity: 1, ...over });

test("5: channel_product_id matches first", () => {
  const r = resolveLine(line({ channelProductId: "CP-1" }), ctx());
  assert.equal(r.status, "matched");
  if (r.status === "matched") { assert.equal(r.via, "channel_product_id"); assert.deepEqual(r.target, { masterProductId: "p2", masterVariantSku: "V-SKU" }); }
});

test("6: SKU matches second", () => {
  const r = resolveLine(line({ sku: "V-SKU" }), ctx());
  assert.equal(r.status, "matched");
  if (r.status === "matched") { assert.equal(r.via, "sku"); assert.equal(r.target.masterVariantSku, "V-SKU"); }
});

test("7: barcode matches third", () => {
  const r = resolveLine(line({ barcode: "V-BC" }), ctx());
  assert.equal(r.status, "matched");
  if (r.status === "matched") assert.equal(r.via, "barcode");
});

test("8: an exact title never auto-matches (title_only_match → review)", () => {
  const r = resolveLine(line({ title: "Prod One" }), ctx());
  assert.equal(r.status, "manual_review");
  if (r.status === "manual_review") assert.equal(r.reason, "title_only_match");
});

test("9: duplicate SKU candidates → ambiguous", () => {
  const c = ctx({ variants: [{ parentProductId: "pA", sku: "DUP", barcode: null }, { parentProductId: "pB", sku: "DUP", barcode: null }] });
  const r = resolveLine(line({ sku: "DUP" }), c);
  assert.equal(r.status === "manual_review" && r.reason, "ambiguous_match");
});

test("10: duplicate barcode candidates → ambiguous", () => {
  const c = ctx({ products: [{ id: "pA", sku: null, barcode: "DUPBC", title: null }, { id: "pB", sku: null, barcode: "DUPBC", title: null }], variants: [] });
  const r = resolveLine(line({ barcode: "DUPBC" }), c);
  assert.equal(r.status === "manual_review" && r.reason, "ambiguous_match");
});

test("11: channelProductId vs SKU pointing at different targets → conflicting_identifiers", () => {
  const r = resolveLine(line({ channelProductId: "CP-1", sku: "PSKU" }), ctx()); // CP-1→p2/V-SKU, PSKU→p1/null
  assert.equal(r.status === "manual_review" && r.reason, "conflicting_identifiers");
});

test("12: an archived mapping never auto-deducts", () => {
  const c = ctx({ mappings: [{ channelProductId: "CP-ARC", exportedSku: null, exportedBarcode: null, masterProductId: "p2", masterVariantSku: "V-SKU", mappingStatus: "archived" }] });
  const r = resolveLine(line({ channelProductId: "CP-ARC" }), c);
  assert.equal(r.status === "manual_review" && r.reason, "inactive_mapping");
});

test("13: a needs_review mapping never auto-deducts", () => {
  const c = ctx({ mappings: [{ channelProductId: "CP-NR", exportedSku: null, exportedBarcode: null, masterProductId: "p2", masterVariantSku: "V-SKU", mappingStatus: "needs_review" }] });
  const r = resolveLine(line({ channelProductId: "CP-NR" }), c);
  assert.equal(r.status === "manual_review" && r.reason, "inactive_mapping");
});

test("14: a variant resolves by SKU, and the target carries no variant id", () => {
  const r = resolveLine(line({ sku: "V-SKU" }), ctx());
  assert.equal(r.status, "matched");
  if (r.status === "matched") {
    assert.deepEqual(Object.keys(r.target).sort(), ["masterProductId", "masterVariantSku"]);
    assert.equal(r.target.masterVariantSku, "V-SKU");
  }
});

test("15: a no-variant product resolves with masterVariantSku = null", () => {
  const r = resolveLine(line({ sku: "PSKU" }), ctx());
  assert.equal(r.status, "matched");
  if (r.status === "matched") assert.deepEqual(r.target, { masterProductId: "p1", masterVariantSku: null });
});

test("2: an invalid quantity line is manual_review", () => {
  const r = resolveLine(line({ sku: "V-SKU", quantity: 0, invalidQuantity: true }), ctx());
  assert.equal(r.status === "manual_review" && r.reason, "invalid_quantity");
});

test("16: lines resolving to the same variant are aggregated (summed, both lineKeys, once)", () => {
  const order = resolveTalabatOrder(
    [line({ lineKey: "line-0", sku: "V-SKU", quantity: 2 }), line({ lineKey: "line-1", barcode: "V-BC", quantity: 3 })],
    ctx(),
  );
  assert.equal(order.status, "resolved");
  if (order.status === "resolved") {
    assert.equal(order.targets.length, 1);
    assert.equal(order.targets[0].quantity, 5);
    assert.deepEqual(order.targets[0].lineKeys.sort(), ["line-0", "line-1"]);
    assert.equal(order.targets[0].masterVariantSku, "V-SKU");
  }
});

test("17: a single unmatched line makes the WHOLE order manual_review (no deduction)", () => {
  const order = resolveTalabatOrder(
    [line({ lineKey: "line-0", sku: "V-SKU", quantity: 1 }), line({ lineKey: "line-1", sku: "NOPE", quantity: 1 })],
    ctx(),
  );
  assert.equal(order.status, "manual_review");
  if (order.status === "manual_review") assert.equal(order.reason, "unmatched");
});
