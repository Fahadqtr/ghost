// Tests for the stock-movement arithmetic core.
// Run: node --experimental-strip-types --test lib/inventory/movements-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeQty, planApply, planEdit, planDelete } from "./movements-compute.ts";

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

// ---- planApply --------------------------------------------------------------

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

// ---- planEdit ---------------------------------------------------------------

test("editing an IN up/down moves stock by the delta", () => {
  // recorded IN of 5 becomes 8 → stock gains the extra 3
  assert.equal(planEdit({ dir: "in", reason: "", oldQty: 5, newQty: 8, stock: 20, sold: 0, oldValue: "10" }).stockAfter, 23);
  // recorded IN of 5 becomes 2 → stock gives back 3
  assert.equal(planEdit({ dir: "in", reason: "", oldQty: 5, newQty: 2, stock: 20, sold: 0, oldValue: "10" }).stockAfter, 17);
});

test("editing an OUT up takes more stock; sale OUT also moves sold", () => {
  const p = planEdit({ dir: "out", reason: "sale", oldQty: 2, newQty: 5, stock: 20, sold: 10, oldValue: "22" });
  assert.equal(p.stockAfter, 17);  // 3 more taken
  assert.equal(p.soldAfter, 13);   // sold follows the delta
});

test("edit sold adjustment is exact-'sale' only (recorded reasons are normalized)", () => {
  const p = planEdit({ dir: "out", reason: "Sale", oldQty: 2, newQty: 5, stock: 20, sold: 10, oldValue: "22" });
  assert.equal(p.soldAfter, null);
});

test("edit clamps stock and sold at zero", () => {
  const p = planEdit({ dir: "out", reason: "sale", oldQty: 1, newQty: 9, stock: 3, sold: 2, oldValue: "x" });
  assert.equal(p.stockAfter, 0); // 3 - 8 clamps
  // sold: 2 + 8 = 10 (delta is positive) — clamping applies on the negative side:
  const down = planEdit({ dir: "out", reason: "sale", oldQty: 9, newQty: 1, stock: 3, sold: 2, oldValue: "x" });
  assert.equal(down.soldAfter, 0); // 2 - 8 clamps
});

test("edit recomputes audit new_value from numeric old_value, else undefined", () => {
  assert.equal(planEdit({ dir: "in", reason: "", oldQty: 5, newQty: 8, stock: 0, sold: 0, oldValue: "10" }).newValue, "18");
  assert.equal(planEdit({ dir: "out", reason: "", oldQty: 5, newQty: 8, stock: 20, sold: 0, oldValue: "10" }).newValue, "2");
  assert.equal(planEdit({ dir: "in", reason: "", oldQty: 5, newQty: 8, stock: 0, sold: 0, oldValue: "legacy" }).newValue, undefined);
});

// ---- planDelete -------------------------------------------------------------

test("deleting an IN takes its stock back out; deleting an OUT restores it", () => {
  assert.deepEqual(planDelete({ dir: "in", reason: "", qty: 4, stock: 10, sold: 0 }), { stockAfter: 6, soldAfter: null });
  assert.deepEqual(planDelete({ dir: "out", reason: "damaged", qty: 4, stock: 10, sold: 0 }), { stockAfter: 14, soldAfter: null });
});

test("deleting a sale OUT rolls back sold_quantity (exact 'sale', clamped)", () => {
  assert.deepEqual(planDelete({ dir: "out", reason: "sale", qty: 4, stock: 10, sold: 6 }), { stockAfter: 14, soldAfter: 2 });
  assert.equal(planDelete({ dir: "out", reason: "sale", qty: 9, stock: 10, sold: 6 }).soldAfter, 0); // clamp
  assert.equal(planDelete({ dir: "out", reason: "Sale", qty: 4, stock: 10, sold: 6 }).soldAfter, null); // exact match only
});

test("delete clamps stock at zero (deleting an IN that was already consumed)", () => {
  assert.equal(planDelete({ dir: "in", reason: "", qty: 9, stock: 4, sold: 0 }).stockAfter, 0);
});
