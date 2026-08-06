// Tests for EAN-13 generation (Phase UI.5). PURE, deterministic digit source.
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/barcode-ean13.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  ean13CheckDigit,
  generateEan13,
  generateUniqueEan13Batch,
  isValidEan13,
} from "./barcode-ean13.ts";

function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

test("check digit matches known EAN-13s", () => {
  // 4006381333931 is the classic reference EAN-13.
  assert.equal(ean13CheckDigit("400638133393"), 1);
  assert.ok(isValidEan13("4006381333931"));
  assert.ok(!isValidEan13("4006381333930"));
  assert.ok(!isValidEan13("400638133393"));
  assert.ok(!isValidEan13("abcdefghijklm"));
  assert.ok(!isValidEan13(4006381333931 as unknown as string));
});

test("generated codes are 13 digits and self-consistent", () => {
  const code = generateEan13(seq([0.1, 0.5, 0.9]));
  assert.match(code, /^\d{13}$/);
  assert.ok(isValidEan13(code));
});

test("batch: every sellable item gets a distinct code, never colliding with the catalog", () => {
  const first = generateEan13(seq([0.42]));
  const existing = new Set([first]);
  // A digit source that first reproduces the taken code, then diverges.
  const random = (() => {
    let calls = 0;
    return () => {
      calls++;
      return calls <= 12 ? 0.42 : (calls % 10) / 10;
    };
  })();
  const batch = generateUniqueEan13Batch(3, existing, random);
  assert.equal(batch.length, 3);
  assert.equal(new Set(batch).size, 3, "no repeats inside the batch");
  for (const code of batch) {
    assert.ok(!existing.has(code), "never a catalog barcode");
    assert.ok(isValidEan13(code));
  }
});

test("batch throws instead of looping forever on a pathological source", () => {
  const stuck = seq([0.42]);
  const taken = new Set([generateEan13(seq([0.42]))]);
  assert.throws(() => generateUniqueEan13Batch(1, taken, stuck, 25), /ean13_generation_exhausted/);
});
