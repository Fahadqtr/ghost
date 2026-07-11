// Tests for the effective-price core.
// Run: node --experimental-strip-types --test lib/products/price-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { effectivePrice, variantPrices, priceRangeLabel } from "./price-compute.ts";

const fmt = (n: number) => `${n} ر.ق`;

test("no variants → falls back to the parent price (discount wins)", () => {
  assert.deepEqual(effectivePrice(80, null, []), { min: 80, max: 80, fromVariants: false, hasPrice: true });
  assert.deepEqual(effectivePrice(80, 60, []), { min: 60, max: 60, fromVariants: false, hasPrice: true });
});

test("priced variants win over the parent, exposing a range", () => {
  const ep = effectivePrice(0, null, [{ price: 30 }, { price: 45 }, { price: 30 }]);
  assert.equal(ep.fromVariants, true);
  assert.equal(ep.min, 30);
  assert.equal(ep.max, 45);
  assert.equal(ep.hasPrice, true);
});

test("a product priced 0 with priced options is NOT missing a price", () => {
  const ep = effectivePrice(0, null, [{ price: 25 }]);
  assert.equal(ep.hasPrice, true);
  assert.equal(ep.min, 25);
});

test("variant discount_price beats its own price", () => {
  assert.deepEqual(variantPrices([{ price: 50, discount_price: 39 }]), [39]);
});

test("variants with no usable price fall back to the parent", () => {
  const ep = effectivePrice(70, null, [{ price: 0 }, { price: null }]);
  assert.equal(ep.fromVariants, false);
  assert.equal(ep.min, 70);
});

test("truly no price anywhere → hasPrice false", () => {
  const ep = effectivePrice(0, null, [{ price: 0 }]);
  assert.equal(ep.hasPrice, false);
  assert.equal(ep.min, null);
});

test("priceRangeLabel formats single vs range", () => {
  assert.equal(priceRangeLabel(effectivePrice(80, null, []), fmt), "80 ر.ق");
  assert.equal(priceRangeLabel(effectivePrice(0, null, [{ price: 30 }, { price: 45 }]), fmt), "30 ر.ق – 45 ر.ق");
  assert.equal(priceRangeLabel(effectivePrice(0, null, [{ price: 0 }]), fmt), "—");
});
