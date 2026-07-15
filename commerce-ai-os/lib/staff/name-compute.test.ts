import test from "node:test";
import assert from "node:assert/strict";

import { canonName, staffNameMatches } from "./name-compute.ts";

test("canonName lowercases, trims, and collapses whitespace", () => {
  assert.equal(canonName("  Ahmad   Ali "), "ahmad ali");
  assert.equal(canonName("MALIKA"), "malika");
});

test("canonName folds Arabic diacritics, tatweel and spelling variants", () => {
  assert.equal(canonName("أحمد"), "احمد");
  assert.equal(canonName("مُحَمَّد"), "محمد");
  assert.equal(canonName("فاطمة"), "فاطمه");
  assert.equal(canonName("منى"), "مني");
});

test("staffNameMatches accepts trivial differences", () => {
  assert.equal(staffNameMatches("  malika ", "Malika"), true);
  assert.equal(staffNameMatches("أحمد", "احمد"), true);
  assert.equal(staffNameMatches("فاطمة", "فاطمه"), true);
});

test("staffNameMatches rejects a wrong name and empty input", () => {
  assert.equal(staffNameMatches("Marow", "Malika"), false);
  assert.equal(staffNameMatches("", "Malika"), false);
  assert.equal(staffNameMatches("  ", "Malika"), false);
});
