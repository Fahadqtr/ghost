// UX.1A — pagination tests.
// node --conditions=react-server --experimental-strip-types --test lib/ui/pagination.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { paginate, DEFAULT_PAGE_SIZE } from "./pagination.ts";

const items = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

test("paginate returns the requested page and 1-based from/to", () => {
  const p = paginate(items(120), 2, 25);
  assert.equal(p.page, 2);
  assert.equal(p.pageCount, 5);
  assert.equal(p.total, 120);
  assert.equal(p.from, 26);
  assert.equal(p.to, 50);
  assert.deepEqual(p.pageItems[0], 26);
  assert.equal(p.pageItems.length, 25);
});

test("the last page holds the remainder", () => {
  const p = paginate(items(53), 3, 25);
  assert.equal(p.page, 3);
  assert.equal(p.pageCount, 3);
  assert.equal(p.pageItems.length, 3);
  assert.equal(p.to, 53);
});

test("out-of-range page clamps into [1, pageCount]", () => {
  assert.equal(paginate(items(30), 99, 25).page, 2);
  assert.equal(paginate(items(30), 0, 25).page, 1);
  assert.equal(paginate(items(30), -5, 25).page, 1);
});

test("empty input yields page 1 of 1 with from/to 0", () => {
  const p = paginate([], 1, 25);
  assert.equal(p.page, 1);
  assert.equal(p.pageCount, 1);
  assert.equal(p.total, 0);
  assert.equal(p.from, 0);
  assert.equal(p.to, 0);
  assert.deepEqual(p.pageItems, []);
});

test("invalid pageSize falls back to the default", () => {
  assert.equal(paginate(items(10), 1, 0).pageSize, DEFAULT_PAGE_SIZE);
  assert.equal(paginate(items(10), 1, -3).pageSize, DEFAULT_PAGE_SIZE);
});

test("only one page renders even when the filtered set is huge (no quadratic render)", () => {
  const p = paginate(items(5000), 1, 25);
  assert.equal(p.pageItems.length, 25, "renders one page, not 5000 rows");
  assert.equal(p.total, 5000, "but the full filtered total is preserved for the counter");
});
