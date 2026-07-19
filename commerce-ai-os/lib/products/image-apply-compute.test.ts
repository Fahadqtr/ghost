// Tests for the "apply images by SKU" pure helpers.
// Run: node --experimental-strip-types --test lib/products/image-apply-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { skuFromFilename, summarizeOutcomes } from "./image-apply-compute.ts";

// ---- skuFromFilename -----------------------------------------------------------

test("strips the extension to recover the SKU", () => {
  assert.equal(skuFromFilename("mk2087.jpg"), "mk2087");
  assert.equal(skuFromFilename("mk2172.JPEG"), "mk2172");
  assert.equal(skuFromFilename("mk2231.png"), "mk2231");
});

test("drops a directory prefix from a folder pick", () => {
  assert.equal(skuFromFilename("missing_119_images/mk2168.jpg"), "mk2168");
  assert.equal(skuFromFilename("C:\\snoonu\\mk2006.jpg"), "mk2006");
});

test("trims stray whitespace but preserves case", () => {
  assert.equal(skuFromFilename("  mk2093.jpg  "), "mk2093");
  assert.equal(skuFromFilename("MK2093.jpg"), "MK2093");
});

test("handles names with no extension and multiple dots", () => {
  assert.equal(skuFromFilename("mk2100"), "mk2100");
  assert.equal(skuFromFilename("mk2100.v2.jpg"), "mk2100.v2");
  assert.equal(skuFromFilename(""), "");
});

// ---- summarizeOutcomes ---------------------------------------------------------

test("tallies each outcome bucket", () => {
  const s = summarizeOutcomes(["applied", "applied", "noProduct", "failed", "applied"]);
  assert.deepEqual(s, { applied: 3, noProduct: 1, failed: 1 });
});

test("empty input is all zeros", () => {
  assert.deepEqual(summarizeOutcomes([]), { applied: 0, noProduct: 0, failed: 0 });
});
