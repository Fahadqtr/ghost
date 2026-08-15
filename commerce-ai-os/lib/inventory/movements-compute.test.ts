// Tests for the stock-movement arithmetic core.
// Run: node --experimental-strip-types --test lib/inventory/movements-compute.test.ts
//
// INV.6A: planEdit / planDelete are retired (the atomic RPCs own edit/delete
// arithmetic in SQL, fail-closed, no clamp). Only normalizeQty + the clamp-free
// planApply remain here.

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeQty, planApply } from "./movements-compute.ts";

// ---- normalizeQty -----------------------------------------------------------

test("normalizeQty floors, strips sign, and zeroes garbage", () => {
  assert.equal(normalizeQty(3), 3);
  assert.equal(normalizeQty("4"), 4);
  assert.equal(normalizeQty(2.9), 2);     // floor
  assert.equal(normalizeQty(-5), 5);      // absolute
  assert.equal(normalizeQty("abc"), 0);   // NaN → 0
  assert.equal(normalizeQty(""), 0);
  assert.equal(normalizeQty(null), 0);
  assert.equal(normalizeQty(Infinity), 0);
});

// ---- planApply (clamp-free: refuses to go negative) -------------------------

test("IN adds to stock; plain OUT subtracts without touching sold", () => {
  assert.deepEqual(planApply({ type: "in", qty: 4, before: 10, sold: 7 }), { after: 14, soldAfter: null });
  assert.deepEqual(planApply({ type: "out", qty: 3, before: 10, sold: 7, reason: "damaged" }), { after: 7, soldAfter: null });
});

test("OUT below zero is refused with the available/requested amounts", () => {
  const r = planApply({ type: "out", qty: 5, before: 3, sold: 0 });
  assert.ok("error" in r);
  assert.match((r as { error: string }).error, /3/); // available
  assert.match((r as { error: string }).error, /5/); // requested
});

test("OUT to exactly zero is allowed", () => {
  assert.deepEqual(planApply({ type: "out", qty: 3, before: 3, sold: 0 }), { after: 0, soldAfter: null });
});

test("a sale OUT advances sold_quantity, case-insensitively", () => {
  assert.deepEqual(planApply({ type: "out", qty: 2, before: 10, sold: 7, reason: "sale" }), { after: 8, soldAfter: 9 });
  assert.deepEqual(planApply({ type: "out", qty: 2, before: 10, sold: 7, reason: "Sale" }), { after: 8, soldAfter: 9 });
});

test("a sale IN never touches sold_quantity (returns are not negative sales)", () => {
  assert.deepEqual(planApply({ type: "in", qty: 2, before: 10, sold: 7, reason: "sale" }), { after: 12, soldAfter: null });
});
