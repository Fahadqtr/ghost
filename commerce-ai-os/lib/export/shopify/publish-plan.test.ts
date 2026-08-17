// INT.2E.2 — Shopify publish-plan tests (pure).
// node --conditions=react-server --experimental-strip-types --test lib/export/shopify/publish-plan.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateRow,
  rowFingerprint,
  isStale,
  tallyResult,
  emptyCounts,
  runStatusFromCounts,
  SUPPORTED_EXECUTION_OPS,
  type PublishTarget,
} from "./publish-plan.ts";
import type { ShopifyPlanOp, ShopifyPreviewStatus } from "./preview.ts";

function target(over: Partial<PublishTarget> = {}): PublishTarget {
  return {
    title: "Serum", descriptionText: "Bright serum.", price: 80, compareAtPrice: 100,
    hasImage: true, imageUrl: "https://cdn/x.jpg",
    variants: [{ variantId: "v1", variantGid: "gid://shopify/ProductVariant/11", sku: "SKU1", barcode: "6291041500213", price: 80 }],
    ...over,
  };
}
function row(status: ShopifyPreviewStatus, plannedOps: ShopifyPlanOp[], over: Partial<{ shopifyProductGid: string | null; changedFields: string[] }> = {}) {
  return {
    internalProductId: "p1", status, shopifyProductGid: over.shopifyProductGid ?? null,
    changedFields: over.changedFields ?? [], plannedOps,
  };
}

test("hard-stops: CONFLICT / BLOCKED / UNKNOWN are never eligible", () => {
  for (const [status, expected] of [["CONFLICT", "CONFLICT"], ["BLOCKED", "BLOCKED"], ["UNKNOWN", "BLOCKED"]] as const) {
    const e = evaluateRow(row(status, [{ type: "BLOCKED", target: "product", fields: [] }]), target());
    assert.equal(e.eligible, false);
    assert.equal(e.ineligibleResult, expected);
    assert.deepEqual(e.executableOps, []);
  }
});

test("MATCH → not eligible, UNCHANGED", () => {
  const e = evaluateRow(row("MATCH", [{ type: "NOOP", target: "product", fields: [] }]), target());
  assert.equal(e.eligible, false);
  assert.equal(e.ineligibleResult, "UNCHANGED");
});

test("NEW → eligible with CREATE_PRODUCT executable", () => {
  const e = evaluateRow(row("NEW", [{ type: "CREATE_PRODUCT", target: "product", fields: ["title", "price"] }]), target());
  assert.equal(e.eligible, true);
  assert.deepEqual(e.executableOps.map((o) => o.type), ["CREATE_PRODUCT"]);
  assert.deepEqual(e.unsupportedOps, []);
});

test("UPDATE_REQUIRED → price + product content executable", () => {
  const e = evaluateRow(row("UPDATE_REQUIRED", [
    { type: "UPDATE_PRODUCT", target: "product", fields: ["title"] },
    { type: "UPDATE_PRICE", target: "variant", variantId: "v1", variantGid: "gid://shopify/ProductVariant/11", fields: ["price"] },
  ], { changedFields: ["title", "price"] }), target());
  assert.equal(e.eligible, true);
  assert.deepEqual(e.executableOps.map((o) => o.type).sort(), ["UPDATE_PRICE", "UPDATE_PRODUCT"]);
});

test("UPDATE_VARIANT (sku/barcode) is NOT executed — SKIPPED_UNSUPPORTED when it's the only op", () => {
  const e = evaluateRow(row("UPDATE_REQUIRED", [
    { type: "UPDATE_VARIANT", target: "variant", variantId: "v1", variantGid: "gid://x/1", fields: ["sku"] },
  ], { changedFields: ["variantSku"] }), target());
  assert.equal(e.eligible, false);
  assert.equal(e.ineligibleResult, "SKIPPED_UNSUPPORTED");
  assert.deepEqual(e.unsupportedOps.map((o) => o.type), ["UPDATE_VARIANT"]);
});

test("add-missing-variant (UPDATE_PRODUCT[variants]) is unsupported", () => {
  const e = evaluateRow(row("UPDATE_REQUIRED", [
    { type: "UPDATE_PRODUCT", target: "product", fields: ["variants"] },
  ], { changedFields: ["variantMissing"] }), target());
  assert.equal(e.eligible, false);
  assert.deepEqual(e.unsupportedOps.map((o) => o.type), ["UPDATE_PRODUCT"]);
});

test("UPDATE_MEDIA add-missing is executable", () => {
  const e = evaluateRow(row("UPDATE_REQUIRED", [
    { type: "UPDATE_MEDIA", target: "media", fields: ["image"] },
  ], { changedFields: ["image"] }), target());
  assert.equal(e.eligible, true);
  assert.deepEqual(e.executableOps.map((o) => o.type), ["UPDATE_MEDIA"]);
});

test("mixed executable + unsupported → eligible, split correctly", () => {
  const e = evaluateRow(row("UPDATE_REQUIRED", [
    { type: "UPDATE_PRICE", target: "variant", variantId: "v1", variantGid: "gid://x/1", fields: ["price"] },
    { type: "UPDATE_VARIANT", target: "variant", variantId: "v1", variantGid: "gid://x/1", fields: ["barcode"] },
  ], { changedFields: ["price", "variantBarcode"] }), target());
  assert.equal(e.eligible, true);
  assert.deepEqual(e.executableOps.map((o) => o.type), ["UPDATE_PRICE"]);
  assert.deepEqual(e.unsupportedOps.map((o) => o.type), ["UPDATE_VARIANT"]);
});

test("fingerprint is stable, and flips when the target value changes (stale protection)", () => {
  const r = row("UPDATE_REQUIRED", [{ type: "UPDATE_PRICE", target: "variant", variantId: "v1", variantGid: "gid://x/1", fields: ["price"] }], { changedFields: ["price"] });
  const f1 = rowFingerprint(r, target({ price: 80 }));
  const f2 = rowFingerprint(r, target({ price: 80 }));
  assert.equal(f1, f2, "deterministic");
  const f3 = rowFingerprint(r, target({ price: 75 }));
  assert.notEqual(f1, f3, "target price change flips the fingerprint");
});

test("fingerprint flips when the plan (status/ops) changes", () => {
  const t = target();
  const f1 = rowFingerprint(row("UPDATE_REQUIRED", [{ type: "UPDATE_PRICE", target: "variant", variantId: "v1", variantGid: "g", fields: ["price"] }], { changedFields: ["price"] }), t);
  const f2 = rowFingerprint(row("MATCH", [{ type: "NOOP", target: "product", fields: [] }]), t);
  assert.notEqual(f1, f2);
});

test("isStale rejects a missing or mismatched confirmation", () => {
  assert.equal(isStale("abc", "abc"), false);
  assert.equal(isStale("abc", "def"), true);
  assert.equal(isStale("abc", null), true);
  assert.equal(isStale("abc", undefined), true);
});

test("run aggregation → SUCCEEDED / PARTIAL / FAILED", () => {
  // all good
  let c = emptyCounts();
  for (const r of ["CREATED", "UPDATED", "UNCHANGED"] as const) c = tallyResult(c, r);
  assert.equal(runStatusFromCounts(c), "SUCCEEDED");
  assert.equal(c.productCount, 3);

  // some success + some failure → PARTIAL
  let p = emptyCounts();
  for (const r of ["CREATED", "FAILED"] as const) p = tallyResult(p, r);
  assert.equal(runStatusFromCounts(p), "PARTIAL");

  // all failure → FAILED
  let f = emptyCounts();
  for (const r of ["FAILED", "NEEDS_RECONCILIATION"] as const) f = tallyResult(f, r);
  assert.equal(runStatusFromCounts(f), "FAILED");

  // only blocked/unchanged/stale → SUCCEEDED (nothing broke)
  let b = emptyCounts();
  for (const r of ["BLOCKED", "UNCHANGED", "STALE", "SKIPPED_UNSUPPORTED"] as const) b = tallyResult(b, r);
  assert.equal(runStatusFromCounts(b), "SUCCEEDED");

  // systemic abort forces FAILED
  assert.equal(runStatusFromCounts(c, { systemicAbort: true }), "FAILED");
});

test("supported execution ops are the conservative set (no UPDATE_VARIANT, no BLOCKED)", () => {
  assert.deepEqual([...SUPPORTED_EXECUTION_OPS].sort(), ["CREATE_PRODUCT", "NOOP", "UPDATE_MEDIA", "UPDATE_PRICE", "UPDATE_PRODUCT"]);
  assert.equal(SUPPORTED_EXECUTION_OPS.includes("UPDATE_VARIANT" as never), false);
  assert.equal(SUPPORTED_EXECUTION_OPS.includes("BLOCKED" as never), false);
});
