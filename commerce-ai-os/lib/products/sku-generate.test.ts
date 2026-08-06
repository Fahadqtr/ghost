// Tests for SKU generation (Phase UI.5). PURE.
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/sku-generate.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  isValidMkSku,
  isValidVariantMkSku,
  maxMkNumber,
  nextMkSku,
  normalizeMkSku,
  renumberVariantSkus,
  variantMkSku,
} from "./sku-generate.ts";

test("mk pattern: valid forms any case, everything else rejected", () => {
  for (const ok of ["mk1", "mk123", "MK123", "Mk1995", " mk42 "]) assert.ok(isValidMkSku(ok), ok);
  for (const bad of ["mk", "mk-1", "mk12a", "PRD123", "123", "", null, 5, "mk123-1", "rhode-mk1"]) {
    assert.ok(!isValidMkSku(bad), String(bad));
  }
});

test("normalizeMkSku lowercases to the catalog form (MK123 -> mk123)", () => {
  assert.equal(normalizeMkSku(" MK123 "), "mk123");
});

test("maxMkNumber scans products AND variant-style skus, ignoring foreign patterns", () => {
  const skus = ["mk1995", "MK7", "mk2001-3", "PRD9", "mk", null, 12, "mk08"];
  assert.equal(maxMkNumber(skus), 2001);
});

test("nextMkSku is highest + 1 and skips explicitly taken numbers", () => {
  assert.equal(nextMkSku(["mk10", "mk12"]), "mk13");
  assert.equal(nextMkSku(["mk10"], new Set(["mk11", "mk12"])), "mk13");
  assert.equal(nextMkSku([]), "mk1");
});

test("variant skus: <main>-n from 1, no padding, no letters — and renumbering closes gaps", () => {
  assert.equal(variantMkSku("MK123", 1), "mk123-1");
  assert.deepEqual(renumberVariantSkus("mk123", 3), ["mk123-1", "mk123-2", "mk123-3"]);
  assert.deepEqual(renumberVariantSkus("mk123", 0), []);
});

test("isValidVariantMkSku accepts only the exact main + dash + positive number", () => {
  assert.ok(isValidVariantMkSku("mk123-1", "mk123"));
  assert.ok(isValidVariantMkSku("MK123-12", "mk123"));
  for (const bad of ["mk123-01", "mk123-A", "mk123-black", "mk124-1", "mk123", "mk123-0", "mk123--1"]) {
    assert.ok(!isValidVariantMkSku(bad, "mk123"), bad);
  }
});
