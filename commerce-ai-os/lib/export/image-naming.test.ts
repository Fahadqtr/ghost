// INT.2A — export image-naming contract tests (PURE).
// node --conditions=react-server --experimental-strip-types --test lib/export/image-naming.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  primaryImageName,
  additionalImageName,
  variantImageName,
  imagePackageNames,
  sanitizeSkuForFilename,
  normalizeExtension,
  extensionFromUrl,
} from "./image-naming.ts";

test("primary image is SKU.ext", () => {
  assert.equal(primaryImageName("MK1001", "jpg"), "MK1001.jpg");
  assert.equal(primaryImageName("MK1001", ".JPG"), "MK1001.jpg"); // ext normalized
  assert.equal(primaryImageName("MK1001"), "MK1001.jpg"); // default ext
});

test("additional images are SKU_2.ext, SKU_3.ext (position 1 = primary)", () => {
  assert.equal(additionalImageName("MK1001", 1, "png"), "MK1001.png");
  assert.equal(additionalImageName("MK1001", 2, "png"), "MK1001_2.png");
  assert.equal(additionalImageName("MK1001", 3, "png"), "MK1001_3.png");
});

test("sellable variant image is VARIANT_SKU.ext", () => {
  assert.equal(variantImageName("MK1001-RED-L", "webp"), "MK1001-RED-L.webp");
});

test("exact SKU case is PRESERVED (not lowercased)", () => {
  assert.equal(primaryImageName("Mk1001aB"), "Mk1001aB.jpg");
  assert.equal(sanitizeSkuForFilename("Mk1001aB"), "Mk1001aB");
});

test("filesystem-invalid characters are sanitized deterministically", () => {
  assert.equal(sanitizeSkuForFilename("MK/10 01"), "MK-10-01");
  assert.equal(sanitizeSkuForFilename("a//b\\c:d*e"), "a-b-c-d-e");
  assert.equal(sanitizeSkuForFilename("--MK1--"), "MK1");
  // stable: same input → same output
  assert.equal(sanitizeSkuForFilename("MK/10 01"), sanitizeSkuForFilename("MK/10 01"));
  // dots/hyphens/underscores are allowed and kept
  assert.equal(sanitizeSkuForFilename("MK_10.01-a"), "MK_10.01-a");
});

test("extension helpers normalize + derive from URLs", () => {
  assert.equal(normalizeExtension("PNG"), "png");
  assert.equal(normalizeExtension(""), "jpg");
  assert.equal(normalizeExtension("weird!"), "jpg");
  assert.equal(extensionFromUrl("https://x/y/MK1.PNG?token=1"), "png");
  assert.equal(extensionFromUrl("https://x/y/noext"), "jpg");
  assert.equal(extensionFromUrl(null), "jpg");
});

test("imagePackageNames builds the ordered SKU-based list", () => {
  assert.deepEqual(imagePackageNames("MK1", 3, "jpg"), ["MK1.jpg", "MK1_2.jpg", "MK1_3.jpg"]);
  assert.deepEqual(imagePackageNames("MK1", 1, "jpg"), ["MK1.jpg"]);
  assert.deepEqual(imagePackageNames("MK1", 0, "jpg"), []);
  assert.deepEqual(imagePackageNames("MK1", -5, "jpg"), []);
});

test("names are never derived from a title and never random", () => {
  // deterministic: two calls identical; no title input exists in the API surface
  assert.equal(primaryImageName("MK9"), primaryImageName("MK9"));
  assert.equal(additionalImageName("MK9", 2), additionalImageName("MK9", 2));
});
