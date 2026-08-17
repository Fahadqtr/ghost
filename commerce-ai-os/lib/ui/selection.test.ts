// UX.1A — selection model tests.
// node --conditions=react-server --experimental-strip-types --test lib/ui/selection.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  toggleKey,
  selectKeys,
  deselectKeys,
  clearSelection,
  allSelected,
  someSelected,
  countSelectedWithin,
  formatSelectionCount,
} from "./selection.ts";

test("toggleKey adds then removes without mutating the input", () => {
  const a = new Set<string>();
  const b = toggleKey(a, "x");
  assert.deepEqual([...a], [], "input untouched");
  assert.deepEqual([...b], ["x"]);
  assert.deepEqual([...toggleKey(b, "x")], []);
});

test("selectKeys (select current page / all filtered) unions keys", () => {
  const sel = selectKeys(new Set(["a"]), ["b", "c", "a"]);
  assert.deepEqual([...sel].sort(), ["a", "b", "c"]);
});

test("deselectKeys removes a page's keys", () => {
  const sel = deselectKeys(new Set(["a", "b", "c"]), ["a", "c"]);
  assert.deepEqual([...sel], ["b"]);
});

test("clearSelection empties the selection", () => {
  assert.equal(clearSelection().size, 0);
});

test("allSelected is true only when every key is selected", () => {
  const page = ["a", "b", "c"];
  assert.equal(allSelected(new Set(["a", "b", "c"]), page), true);
  assert.equal(allSelected(new Set(["a", "b"]), page), false);
  assert.equal(allSelected(new Set(), []), false, "empty page is not 'all selected'");
});

test("someSelected marks the indeterminate (partial) state", () => {
  const page = ["a", "b", "c"];
  assert.equal(someSelected(new Set(["a"]), page), true);
  assert.equal(someSelected(new Set(["a", "b", "c"]), page), false, "all → not indeterminate");
  assert.equal(someSelected(new Set(), page), false);
});

test("countSelectedWithin counts only keys inside the filtered set (the counter's X)", () => {
  // selection may contain keys outside the current filter; the counter is scoped
  const sel = new Set(["a", "z"]);
  assert.equal(countSelectedWithin(sel, ["a", "b", "c"]), 1);
});

test("formatSelectionCount renders 'X of Y' and floors negatives to 0", () => {
  assert.equal(formatSelectionCount(3, 528), "3 of 528");
  assert.equal(formatSelectionCount(0, 0), "0 of 0");
  assert.equal(formatSelectionCount(-2, -5), "0 of 0");
});
