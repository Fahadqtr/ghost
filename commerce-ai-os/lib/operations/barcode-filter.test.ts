// OPS.7 — barcode deep-link filter tests. PURE.
// node --conditions=react-server --experimental-strip-types --test lib/operations/barcode-filter.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { parseBarcodeFilter, filterBarcodeRows, hasBarcodeFilter } from "./barcode-filter.ts";

// ── param validation ──────────────────────────────────────────────────────────
test("parseBarcodeFilter validates status and sanitizes sku; junk → null", () => {
  assert.deepEqual(parseBarcodeFilter({ sku: "MCB-1", status: "AUTO_COMPLETABLE" }), { sku: "MCB-1", status: "AUTO_COMPLETABLE" });
  assert.deepEqual(parseBarcodeFilter({ status: "NOT_A_STATUS" }), { sku: null, status: null });
  assert.deepEqual(parseBarcodeFilter({ sku: "  ' OR 1=1 " }), { sku: null, status: null }); // filter syntax rejected
  assert.deepEqual(parseBarcodeFilter(null), { sku: null, status: null });
  assert.deepEqual(parseBarcodeFilter({ status: ["CONFLICT", "x"] }), { sku: null, status: "CONFLICT" }); // first of array
});

test("hasBarcodeFilter reflects whether any filter is set", () => {
  assert.equal(hasBarcodeFilter({ sku: null, status: null }), false);
  assert.equal(hasBarcodeFilter({ sku: "x", status: null }), true);
  assert.equal(hasBarcodeFilter({ sku: null, status: "CONFLICT" }), true);
});

// ── display filtering (read-only narrowing) ───────────────────────────────────
const rows = [
  { sku: "MCB-ZERO", status: "AUTO_COMPLETABLE" },
  { sku: "ANU-TONER", status: "CONFLICT" },
  { sku: "mcb-pad", status: "NEEDS_REVIEW" },
];

test("filterBarcodeRows narrows by status (exact) and sku (case-insensitive substring)", () => {
  assert.deepEqual(filterBarcodeRows(rows, { sku: null, status: "CONFLICT" }).map((r) => r.sku), ["ANU-TONER"]);
  assert.deepEqual(filterBarcodeRows(rows, { sku: "mcb", status: null }).map((r) => r.sku), ["MCB-ZERO", "mcb-pad"]);
  assert.deepEqual(filterBarcodeRows(rows, { sku: "mcb", status: "NEEDS_REVIEW" }).map((r) => r.sku), ["mcb-pad"]);
  assert.equal(filterBarcodeRows(rows, { sku: null, status: null }).length, 3); // no filter → all
  assert.equal(filterBarcodeRows([], { sku: "x", status: null }).length, 0);
});
