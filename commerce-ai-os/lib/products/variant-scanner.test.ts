// UX.4E-9C — variant barcode scanner flow: pure decision tests. Exercises the
// ONE ordering rule ported from the retired legacy editor: given the rows and the
// row an Enter fired in, which row's barcode field gets focus next. No React, no
// DOM — the decision is framework-free by design and shared by both V2 editors.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/variant-scanner.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { nextActiveBarcodeKey, type ScannerRowRef } from "./variant-scanner.ts";

// Stable keys deliberately do NOT match array position, proving identity is the
// key and never the index.
const rows: ScannerRowRef[] = [
  { key: "row-c" },
  { key: "row-a" },
  { key: "row-b" },
];

test("Enter on the first barcode advances to the second row's key", () => {
  assert.equal(nextActiveBarcodeKey(rows, "row-c"), "row-a");
});

test("Enter advances by stable key, not by array index", () => {
  assert.equal(nextActiveBarcodeKey(rows, "row-a"), "row-b");
});

test("a soft-removed row is skipped on the way to the next active field", () => {
  const withRemoved: ScannerRowRef[] = [
    { key: "row-c" },
    { key: "row-a", removed: true }, // scanner must jump over this one
    { key: "row-b" },
  ];
  assert.equal(nextActiveBarcodeKey(withRemoved, "row-c"), "row-b");
});

test("Enter on the last active barcode is safe — returns null (no wrap, no new row)", () => {
  assert.equal(nextActiveBarcodeKey(rows, "row-b"), null);
});

test("last active field when trailing rows are all removed returns null", () => {
  const trailingRemoved: ScannerRowRef[] = [
    { key: "row-c" },
    { key: "row-a" },
    { key: "row-b", removed: true },
  ];
  // row-a is now the last ACTIVE row → nothing after it.
  assert.equal(nextActiveBarcodeKey(trailingRemoved, "row-a"), null);
});

test("Enter fired from a removed row returns null (it is not in the active order)", () => {
  const withRemoved: ScannerRowRef[] = [
    { key: "row-c" },
    { key: "row-a", removed: true },
    { key: "row-b" },
  ];
  assert.equal(nextActiveBarcodeKey(withRemoved, "row-a"), null);
});

test("an unknown key returns null — never throws", () => {
  assert.equal(nextActiveBarcodeKey(rows, "does-not-exist"), null);
});

test("a single active row has no next field", () => {
  assert.equal(nextActiveBarcodeKey([{ key: "only" }], "only"), null);
});

test("the empty row set is safe", () => {
  assert.equal(nextActiveBarcodeKey([], "row-c"), null);
});
