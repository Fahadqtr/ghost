// Product Readiness Engine tests (Phase UI.7.1). PURE — no DB, no network.
// Run: node --conditions=react-server --experimental-strip-types --test lib/operations/readiness/readiness.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { computeProductReadiness, isNewProduct, READINESS_MESSAGES } from "./readiness.ts";
import { makeProduct } from "../shared/test-fixtures.ts";

test("complete approved product: ready, 100%, no reasons, publishable, not new", () => {
  const r = computeProductReadiness(makeProduct());
  assert.equal(r.status, "ready");
  assert.equal(r.percent, 100);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.readyToPublish, true);
  assert.equal(r.isNew, false);
  assert.equal(r.productId, "p1");
  assert.equal(r.checks.length, 8, "variants check only appears when expected");
});

test("missing image: incomplete, the image check fails, fixed Arabic reason", () => {
  const r = computeProductReadiness(makeProduct({ imageUrl: null }));
  assert.equal(r.status, "incomplete");
  assert.equal(r.readyToPublish, false);
  assert.ok(r.percent < 100);
  assert.ok(r.checks.some((c) => c.code === "image" && !c.passed && c.required));
  assert.deepEqual(r.reasons.map((x) => x.code), ["missing_image"]);
  assert.equal(r.reasons[0].message, READINESS_MESSAGES.missing_image);
});

test("sku: missing vs malformed are DIFFERENT reasons; malformed forces review", () => {
  const missing = computeProductReadiness(makeProduct({ sku: null }));
  assert.deepEqual(missing.reasons.map((x) => x.code), ["missing_sku"]);
  assert.equal(missing.status, "incomplete");

  const malformed = computeProductReadiness(makeProduct({ sku: "PRD-99" }));
  assert.ok(malformed.reasons.some((x) => x.code === "invalid_sku"));
  assert.equal(malformed.status, "needs_review", "a wrong-shaped identifier needs a human");

  const uppercase = computeProductReadiness(makeProduct({ sku: "MK123" }));
  assert.equal(uppercase.status, "ready", "MK123 normalizes to the house mk pattern");
});

test("barcode: missing vs malformed; 6–14 digits accepted", () => {
  const missing = computeProductReadiness(makeProduct({ barcode: "  " }));
  assert.deepEqual(missing.reasons.map((x) => x.code), ["missing_barcode"]);
  const malformed = computeProductReadiness(makeProduct({ barcode: "12ab34" }));
  assert.equal(malformed.status, "needs_review");
  assert.ok(malformed.reasons.some((x) => x.code === "invalid_barcode"));
  assert.equal(computeProductReadiness(makeProduct({ barcode: "123456" })).status, "ready");
});

test("price: null, zero and negative all fail; positive passes", () => {
  for (const price of [null, 0, -5]) {
    const r = computeProductReadiness(makeProduct({ price }));
    assert.ok(r.reasons.some((x) => x.code === "missing_price"), String(price));
    assert.equal(r.status, "incomplete");
  }
  assert.equal(computeProductReadiness(makeProduct({ price: 0.5 })).status, "ready");
});

test("variants: only checked when TRUSTED-expected; missing variants then block readiness", () => {
  const expected = computeProductReadiness(makeProduct({ expectsVariants: true, variantCount: 0 }));
  assert.equal(expected.status, "incomplete");
  assert.ok(expected.reasons.some((x) => x.code === "missing_variants"));
  assert.equal(expected.checks.length, 9);

  const satisfied = computeProductReadiness(makeProduct({ expectsVariants: true, variantCount: 3 }));
  assert.equal(satisfied.status, "ready");
});

test("variants unknown: no variant rows NEVER counts against readiness", () => {
  const unknown = computeProductReadiness(makeProduct({ variantCount: 0 }));
  assert.equal(unknown.status, "ready");
  assert.equal(unknown.checks.length, 8, "no variants check when expectation is unknown");
  assert.ok(!unknown.reasons.some((x) => x.code === "missing_variants"));
});

test("variants present: their existence CONFIRMS a multi-variant product (check passes)", () => {
  const confirmed = computeProductReadiness(makeProduct({ variantCount: 2 }));
  assert.equal(confirmed.status, "ready");
  assert.equal(confirmed.checks.length, 9);
  assert.ok(confirmed.checks.some((c) => c.code === "variants" && c.passed));
});

test("new product: never reviewed + never pushed → isNew and almost_ready when data is complete", () => {
  const p = makeProduct({ approval: "", platformStatus: "" });
  assert.equal(isNewProduct(p), true);
  const r = computeProductReadiness(p);
  assert.equal(r.isNew, true);
  assert.equal(r.status, "almost_ready", "complete data, waiting only for approval");
  assert.ok(r.reasons.some((x) => x.code === "not_approved"));
  assert.equal(r.readyToPublish, false, "unapproved is never publishable");
});

test("review states: SentAI and Rejected always need a human", () => {
  const pending = computeProductReadiness(makeProduct({ approval: "SentAI" }));
  assert.equal(pending.status, "needs_review");
  assert.ok(pending.reasons.some((x) => x.code === "pending_review"));

  const rejected = computeProductReadiness(makeProduct({ approval: "Rejected" }));
  assert.equal(rejected.status, "needs_review");
  assert.ok(rejected.reasons.some((x) => x.code === "rejected"));
});

test("optional checks (description/brand) lower the percent but never the status", () => {
  const r = computeProductReadiness(
    makeProduct({ descriptionAr: null, descriptionEn: "", brandId: null }),
  );
  assert.equal(r.status, "ready", "optional gaps do not block publishing");
  assert.equal(r.percent, Math.round((6 / 8) * 100));
  assert.deepEqual(r.reasons.map((x) => x.code).sort(), ["missing_brand", "missing_description"]);
});

test("worst case: everything missing — all reasons, 0%, incomplete", () => {
  const r = computeProductReadiness(
    makeProduct({
      sku: null, barcode: null, nameAr: null, nameEn: null, descriptionAr: null,
      descriptionEn: null, brandId: null, category: null, price: null, imageUrl: null,
      approval: "", platformStatus: "",
    }),
  );
  assert.equal(r.status, "incomplete");
  assert.equal(r.percent, 0);
  assert.equal(r.isNew, true);
  assert.equal(r.reasons.length, 8);
});
