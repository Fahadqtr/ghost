// Tests for the ad-overlay text core.
// Run: node --experimental-strip-types --test lib/social/ad-overlay-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { formatQar, buildAdText } from "./ad-overlay-compute.ts";

// ---- formatQar ----------------------------------------------------------------

test("formats positive amounts with the riyal suffix, trims .0", () => {
  assert.equal(formatQar(86), "86 ر.ق");
  assert.equal(formatQar("120"), "120 ر.ق");
  assert.equal(formatQar(79.5), "79.5 ر.ق");
  assert.equal(formatQar(100.0), "100 ر.ق");
});

test("empty for missing, zero, negative, or non-numeric", () => {
  assert.equal(formatQar(null), "");
  assert.equal(formatQar(undefined), "");
  assert.equal(formatQar(0), "");
  assert.equal(formatQar(-5), "");
  assert.equal(formatQar(""), "");
  assert.equal(formatQar("abc"), "");
});

// ---- buildAdText --------------------------------------------------------------

test("discount price wins over list price", () => {
  const t = buildAdText({ brand: "Rhode", nameAr: "سيروم", price: 100, discountPrice: 79 });
  assert.equal(t.price, "79 ر.ق");
  assert.equal(t.brand, "Rhode");
  assert.equal(t.product, "سيروم");
  assert.ok(t.cta.includes("اطلبيه الآن"));
  assert.ok(t.cta.includes("ORDER NOW"));
});

test("falls back to the list price when there is no discount", () => {
  assert.equal(buildAdText({ price: 100, discountPrice: null }).price, "100 ر.ق");
  assert.equal(buildAdText({ price: 100, discountPrice: 0 }).price, "100 ر.ق");
});

test("brand empty when absent; product falls back to English", () => {
  const t = buildAdText({ brand: null, nameAr: "", nameEn: "Glow Serum" });
  assert.equal(t.brand, "");
  assert.equal(t.product, "Glow Serum");
});

test("price empty when the product has none", () => {
  assert.equal(buildAdText({ nameAr: "منتج" }).price, "");
});
