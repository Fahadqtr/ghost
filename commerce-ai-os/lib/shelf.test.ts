// Tests for shelf-slot parsing / natural sorting.
// Run: node --conditions=react-server --experimental-strip-types --test lib/shelf.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { shelfOf, compareSlot } from "./shelf.ts";

test("shelfOf extracts and upper-cases the letter prefix", () => {
  assert.equal(shelfOf("A1"), "A");
  assert.equal(shelfOf("ab12"), "AB");
  assert.equal(shelfOf("  c3  "), "C");
});

test("shelfOf handles empty / nullish input", () => {
  assert.equal(shelfOf(null), null);
  assert.equal(shelfOf(undefined), null);
  assert.equal(shelfOf(""), null);
});

test("compareSlot sorts by shelf, then numerically (not lexically)", () => {
  const sorted = ["A10", "A2", "B1", "A1"].sort(compareSlot);
  assert.deepEqual(sorted, ["A1", "A2", "A10", "B1"]);
});

test("compareSlot orders different shelves alphabetically", () => {
  assert.ok(compareSlot("A9", "B1") < 0);
  assert.ok(compareSlot("C1", "B99") > 0);
});
