// New Product Engine tests (Phase UI.7.1).
// Run: node --conditions=react-server --experimental-strip-types --test lib/operations/new-products/new-product-engine.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { computeProductReadiness } from "../readiness/readiness.ts";
import { classifyNewProducts } from "./new-product-engine.ts";
import { makeProduct } from "../shared/test-fixtures.ts";

test("buckets a mixed catalog; overlap is allowed (new + needs image)", () => {
  const readiness = [
    makeProduct({ id: "ready1" }),
    makeProduct({ id: "new-no-image", approval: "", platformStatus: "", imageUrl: null }),
    makeProduct({ id: "review1", approval: "SentAI" }),
    makeProduct({ id: "no-image", imageUrl: null }),
  ].map(computeProductReadiness);

  const b = classifyNewProducts(readiness);
  assert.deepEqual(b.readyProducts, ["ready1"]);
  assert.deepEqual(b.newProducts, ["new-no-image"]);
  assert.deepEqual(b.needsImage, ["new-no-image", "no-image"], "a product may sit in several buckets");
  assert.deepEqual(b.needsReview, ["review1"]);
});

test("a complete but unapproved product is new — and NOT ready", () => {
  const b = classifyNewProducts([computeProductReadiness(makeProduct({ approval: "", platformStatus: "" }))]);
  assert.deepEqual(b.newProducts, ["p1"]);
  assert.deepEqual(b.readyProducts, []);
});

test("empty catalog: all buckets empty", () => {
  assert.deepEqual(classifyNewProducts([]), {
    newProducts: [],
    readyProducts: [],
    needsImage: [],
    needsReview: [],
  });
});
