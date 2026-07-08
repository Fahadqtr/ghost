// Tests for the platform-entry verification verdicts.
// Run: node --experimental-strip-types --test lib/tasks/verify-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { verdictForTask, type VerifyTaskLite, type PlatformIndexLite } from "./verify-compute.ts";

const idx = (over: Partial<PlatformIndexLite> = {}): PlatformIndexLite => ({
  hasSku: () => false, hasName: () => false, priceFor: () => null, ...over,
});
const task = (over: Partial<VerifyTaskLite>): VerifyTaskLite => ({
  id: "t1", status: "done", action: "create", sku: "mk1", name_en: "Rose Serum", price: 99, ...over,
});

test("present + right price → confirmed", () => {
  const v = verdictForTask(task({}), idx({ hasSku: (s) => s === "mk1", priceFor: () => 99 }));
  assert.equal(v.status, "confirmed");
  assert.equal(v.reopen, false);
});

test("missing entry reopens a done task; open task flagged without reopen", () => {
  const done = verdictForTask(task({}), idx());
  assert.equal(done.status, "missing");
  assert.equal(done.reopen, true);
  const open = verdictForTask(task({ status: "open" }), idx());
  assert.equal(open.reopen, false);
});

test("price mismatch beyond a fils reopens; no price column passes", () => {
  const bad = verdictForTask(task({}), idx({ hasSku: () => true, priceFor: () => 89 }));
  assert.equal(bad.status, "price_mismatch");
  assert.equal(bad.reopen, true);
  const noCol = verdictForTask(task({}), idx({ hasSku: () => true, priceFor: () => null }));
  assert.equal(noCol.status, "confirmed");
});

test("delete: absent → confirmed; still present → reopen with instruction", () => {
  const gone = verdictForTask(task({ action: "delete" }), idx());
  assert.equal(gone.status, "confirmed");
  const still = verdictForTask(task({ action: "delete" }), idx({ hasName: () => true }));
  assert.equal(still.status, "still_present");
  assert.equal(still.reopen, true);
});

test("bulk and empty-identity tasks are skipped", () => {
  assert.equal(verdictForTask(task({ action: "bulk" }), idx()).status, "skipped");
  assert.equal(verdictForTask(task({ sku: null, name_en: "" }), idx()).status, "skipped");
});
