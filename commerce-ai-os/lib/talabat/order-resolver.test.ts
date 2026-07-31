// Tests for the pure Talabat order resolver (matching ladder + aggregation +
// all-or-nothing + inactive/parent guards). Fixtures only — NO Supabase, NO network.
// Run: node --conditions=react-server --experimental-strip-types --test lib/talabat/order-resolver.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { resolveLine, resolveTalabatOrder, type ResolveContext, type ResolverLine } from "./order-resolver.ts";

function ctx(over: Partial<ResolveContext> = {}): ResolveContext {
  return {
    mappings: [
      { channelProductId: "CP-1", exportedSku: "V-SKU", exportedBarcode: "V-BC", masterProductId: "p2", masterVariantSku: "V-SKU", mappingStatus: "active" },
      { channelProductId: "CP-ARC", exportedSku: "VBLK", exportedBarcode: "BBLK", masterProductId: "p2", masterVariantSku: "VBLK", mappingStatus: "archived" },
      { channelProductId: "CP-NR", exportedSku: null, exportedBarcode: null, masterProductId: "p2", masterVariantSku: "V-SKU", mappingStatus: "needs_review" },
    ],
    products: [
      { id: "p1", sku: "PSKU", barcode: "PBC", title: "Prod One" },   // no variants
      { id: "p2", sku: null, barcode: null, title: "Prod Two" },      // has variants
      { id: "p3", sku: "P3SKU", barcode: "P3BC", title: "Prod Three" }, // has a variant
    ],
    variants: [
      { parentProductId: "p2", sku: "V-SKU", barcode: "V-BC" },
      { parentProductId: "p2", sku: "VBLK", barcode: "BBLK" },
      { parentProductId: "p3", sku: "P3-V1", barcode: "P3-V1-BC" },
    ],
    ...over,
  };
}
const line = (over: Partial<ResolverLine>): ResolverLine => ({ lineKey: "line-0", channelProductId: null, sku: null, barcode: null, title: null, quantity: 1, ...over });
const reasonOf = (r: ReturnType<typeof resolveLine>) => (r.status === "manual_review" ? r.reason : null);

test("5: channel_product_id matches first", () => {
  const r = resolveLine(line({ channelProductId: "CP-1" }), ctx());
  assert.equal(r.status, "matched");
  if (r.status === "matched") { assert.equal(r.via, "channel_product_id"); assert.deepEqual(r.target, { masterProductId: "p2", masterVariantSku: "V-SKU" }); }
});

test("6: SKU matches second", () => {
  const r = resolveLine(line({ sku: "V-SKU" }), ctx());
  assert.equal(r.status, "matched");
  if (r.status === "matched") assert.equal(r.target.masterVariantSku, "V-SKU");
});

test("7: barcode matches third", () => {
  const r = resolveLine(line({ barcode: "V-BC" }), ctx());
  assert.equal(r.status, "matched");
  if (r.status === "matched") assert.equal(r.via, "barcode");
});

test("8: an exact title never auto-matches", () => {
  assert.equal(reasonOf(resolveLine(line({ title: "Prod One" }), ctx())), "title_only_match");
});

test("9: duplicate SKU candidates → ambiguous", () => {
  const c = ctx({ mappings: [], variants: [{ parentProductId: "pA", sku: "DUP", barcode: null }, { parentProductId: "pB", sku: "DUP", barcode: null }], products: [] });
  assert.equal(reasonOf(resolveLine(line({ sku: "DUP" }), c)), "ambiguous_match");
});

test("10: duplicate barcode candidates → ambiguous", () => {
  const c = ctx({ mappings: [], products: [{ id: "pA", sku: null, barcode: "DUPBC", title: null }, { id: "pB", sku: null, barcode: "DUPBC", title: null }], variants: [] });
  assert.equal(reasonOf(resolveLine(line({ barcode: "DUPBC" }), c)), "ambiguous_match");
});

test("11: channelProductId vs SKU pointing at different targets → conflicting_identifiers", () => {
  assert.equal(reasonOf(resolveLine(line({ channelProductId: "CP-1", sku: "PSKU" }), ctx())), "conflicting_identifiers");
});

test("12: an archived mapping never auto-deducts", () => {
  assert.equal(reasonOf(resolveLine(line({ channelProductId: "CP-ARC" }), ctx())), "inactive_mapping");
});

test("13: a needs_review mapping never auto-deducts", () => {
  assert.equal(reasonOf(resolveLine(line({ channelProductId: "CP-NR" }), ctx())), "inactive_mapping");
});

test("inactive: an archived mapping cannot be bypassed via the variant SKU", () => {
  assert.equal(reasonOf(resolveLine(line({ sku: "VBLK" }), ctx())), "inactive_mapping");
});

test("inactive: an archived mapping cannot be bypassed via the barcode", () => {
  assert.equal(reasonOf(resolveLine(line({ barcode: "BBLK" }), ctx())), "inactive_mapping");
});

test("14: a variant resolves by SKU; the target carries no variant id", () => {
  const r = resolveLine(line({ sku: "V-SKU" }), ctx());
  assert.equal(r.status, "matched");
  if (r.status === "matched") { assert.deepEqual(Object.keys(r.target).sort(), ["masterProductId", "masterVariantSku"]); assert.equal(r.target.masterVariantSku, "V-SKU"); }
});

test("15: a no-variant product resolves with masterVariantSku = null", () => {
  const r = resolveLine(line({ sku: "PSKU" }), ctx());
  assert.equal(r.status, "matched");
  if (r.status === "matched") assert.deepEqual(r.target, { masterProductId: "p1", masterVariantSku: null });
});

test("3: a parent SKU on a product WITH variants never deducts the generic parent", () => {
  assert.equal(reasonOf(resolveLine(line({ sku: "P3SKU" }), ctx())), "ambiguous_match");
});

test("3: a parent barcode on a product WITH variants never deducts the generic parent", () => {
  assert.equal(reasonOf(resolveLine(line({ barcode: "P3BC" }), ctx())), "ambiguous_match");
});

test("4: a variant barcode hit whose variant row has NO SKU never resolves as a no-variant parent", () => {
  // A variant row matched by barcode but with a null/empty SKU has no durable
  // identity — it must NOT become masterVariantSku=null (a real no-variant product).
  const cNull = ctx({ mappings: [], products: [], variants: [{ parentProductId: "pX", sku: null, barcode: "NBC" }] });
  assert.equal(reasonOf(resolveLine(line({ barcode: "NBC" }), cNull)), "ambiguous_match");
  const cEmpty = ctx({ mappings: [], products: [], variants: [{ parentProductId: "pX", sku: "  ", barcode: "EBC" }] });
  assert.equal(reasonOf(resolveLine(line({ barcode: "EBC" }), cEmpty)), "ambiguous_match");
});

test("3: the unique variant SKU of a variant product resolves to that variant", () => {
  const r = resolveLine(line({ sku: "P3-V1" }), ctx());
  assert.equal(r.status, "matched");
  if (r.status === "matched") assert.deepEqual(r.target, { masterProductId: "p3", masterVariantSku: "P3-V1" });
});

test("2: an invalid-quantity line is manual_review", () => {
  assert.equal(reasonOf(resolveLine(line({ sku: "V-SKU", quantity: 0, invalidQuantity: true }), ctx())), "invalid_quantity");
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
  }
});

test("17: a single unmatched line makes the WHOLE order manual_review", () => {
  const order = resolveTalabatOrder([line({ sku: "V-SKU", quantity: 1 }), line({ lineKey: "line-1", sku: "NOPE", quantity: 1 })], ctx());
  assert.equal(order.status === "manual_review" && order.reason, "unmatched");
});

test("empty: an empty order → manual_review empty_order", () => {
  const order = resolveTalabatOrder([], ctx());
  assert.equal(order.status === "manual_review" && order.reason, "empty_order");
});

test("weak: a weak dedup identity blocks automatic deduction", () => {
  const order = resolveTalabatOrder([line({ sku: "V-SKU", quantity: 1 })], ctx(), { dedupConfidence: "weak" });
  assert.equal(order.status === "manual_review" && order.reason, "weak_order_identity");
});
