// UX.4E-5 — pure variant BULK operations. Proves each transform is immutable,
// composes the shared layers, and honors the persisted-identity safety rules.
// PURE — no DB, no network, no React. Run:
//   node --conditions=react-server --experimental-strip-types --test lib/products/variant-bulk.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  fillMissingPrice,
  fillMissingStock,
  setSelectedPrice,
  setSelectedStock,
  addRows,
  duplicateRow,
  markSelectedRemoved,
  restoreSelected,
  removeEmptyRows,
  generateMissingSkus,
  generateMissingBarcodes,
  withinAddBatchLimit,
  MAX_BULK_ADD_BATCH,
} from "./variant-bulk.ts";
import { makeVariantRow, type VariantRowModel } from "./variant-model.ts";
import { readFileSync } from "node:fs";

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

// A persisted (existing) row: has a database id + values.
function persisted(key: string, over: Partial<VariantRowModel["fields"]> = {}, id = key): VariantRowModel {
  return makeVariantRow(key, { id, fields: { variant_name: "لون", sku: `mk9-${key}`, barcode: "4006381333931", price: "10", stock_quantity: "3", ...over } });
}
// A new (id: null) row.
function fresh(key: string, over: Partial<VariantRowModel["fields"]> = {}): VariantRowModel {
  return makeVariantRow(key, { fields: over });
}

function snapshot(rows: readonly VariantRowModel[]): string {
  return JSON.stringify(rows);
}

// ── fill missing (blanks only, never overwrite) ──────────────────────────────

test("fillMissingPrice: fills blank prices, leaves existing prices untouched", () => {
  const rows = [persisted("a", { price: "99" }), fresh("b", { price: "" }), fresh("c", { price: "" })];
  const out = fillMissingPrice(rows, "25");
  assert.equal(out[0].fields.price, "99"); // existing untouched
  assert.equal(out[1].fields.price, "25");
  assert.equal(out[2].fields.price, "25");
});

test("fillMissingStock: fills blank stock, leaves existing stock untouched", () => {
  const rows = [persisted("a", { stock_quantity: "7" }), fresh("b", { stock_quantity: "" })];
  const out = fillMissingStock(rows, "12");
  assert.equal(out[0].fields.stock_quantity, "7");
  assert.equal(out[1].fields.stock_quantity, "12");
});

// ── explicit set-selected (overwrite allowed) ────────────────────────────────

test("setSelectedPrice/Stock: overwrites ONLY the selected rows", () => {
  const rows = [persisted("a", { price: "10", stock_quantity: "1" }), persisted("b", { price: "20", stock_quantity: "2" })];
  const priced = setSelectedPrice(rows, new Set(["b"]), "77");
  assert.equal(priced[0].fields.price, "10"); // unselected untouched
  assert.equal(priced[1].fields.price, "77"); // selected overwritten
  const stocked = setSelectedStock(rows, new Set(["a"]), "5");
  assert.equal(stocked[0].fields.stock_quantity, "5");
  assert.equal(stocked[1].fields.stock_quantity, "2");
});

// ── generate missing SKU/barcode (blanks only; persisted never renumbered) ────

test("generateMissingSkus: fills only blank SKUs, existing SKUs verbatim (no renumber)", () => {
  const rows = [persisted("a", { sku: "mk9-legacy" }), fresh("b", { sku: "" })];
  const out = generateMissingSkus("mk9", rows);
  assert.equal(out[0].fields.sku, "mk9-legacy"); // persisted SKU never renumbered
  assert.equal(out[1].fields.sku, "mk9-2"); // blank filled by 1-based position
});

test("generateMissingBarcodes: fills only blank barcodes, existing barcodes verbatim", () => {
  const rows = [persisted("a", { barcode: "4006381333931" }), fresh("b", { barcode: "" })];
  const seq = (() => { let n = 0.1; return () => (n = (n * 9301 + 0.4243) % 1); })();
  const out = generateMissingBarcodes(rows, new Set<string>(), seq, ["4006381333931"]);
  assert.equal(out[0].fields.barcode, "4006381333931"); // existing untouched
  assert.equal(out[1].fields.barcode.length, 13, "blank filled with a fresh EAN-13");
  assert.notEqual(out[1].fields.barcode, "4006381333931", "never collides with the taken barcode");
});

// ── add rows + count guard ───────────────────────────────────────────────────

test("addRows: appends exactly `count` deterministic rows via the key factory", () => {
  const out = addRows([fresh("x")], 3, (i) => `new-${i}`);
  assert.equal(out.length, 4);
  assert.deepEqual(out.slice(1).map((r) => r.key), ["new-0", "new-1", "new-2"]);
  assert.ok(out.slice(1).every((r) => r.id === null && !r.removed));
  // deterministic: same inputs → same keys
  assert.deepEqual(addRows([], 2, (i) => `k${i}`).map((r) => r.key), ["k0", "k1"]);
});

test("count guard: withinAddBatchLimit enforces 1..MAX_BULK_ADD_BATCH via the shared predicate", () => {
  assert.equal(withinAddBatchLimit(1), true);
  assert.equal(withinAddBatchLimit(MAX_BULK_ADD_BATCH), true);
  assert.equal(withinAddBatchLimit(MAX_BULK_ADD_BATCH + 1), false);
  assert.equal(withinAddBatchLimit(0), false);
  assert.equal(withinAddBatchLimit(-3), false);
  assert.equal(withinAddBatchLimit(2.5), false);
});

// ── delete / restore selected ────────────────────────────────────────────────

test("markSelectedRemoved: new selected row DROPS; persisted selected row SOFT-removes (id kept)", () => {
  const rows = [persisted("p1"), fresh("n1"), persisted("p2")];
  const out = markSelectedRemoved(rows, new Set(["n1", "p2"]));
  assert.deepEqual(out.map((r) => r.key), ["p1", "p2"]); // n1 dropped, p2 kept
  const p2 = out.find((r) => r.key === "p2")!;
  assert.equal(p2.removed, true);
  assert.equal(p2.id, "p2"); // id never changed
  assert.equal(out.find((r) => r.key === "p1")!.removed, false); // unselected untouched
});

test("markSelectedRemoved: never auto-deletes a persisted row that was not selected", () => {
  const rows = [persisted("p1"), persisted("p2")];
  const out = markSelectedRemoved(rows, new Set(["p1"]));
  assert.equal(out.find((r) => r.key === "p2")!.removed, false);
});

test("restoreSelected: un-removes selected persisted rows only", () => {
  const removed = markSelectedRemoved([persisted("p1"), persisted("p2")], new Set(["p1", "p2"]));
  const out = restoreSelected(removed, new Set(["p1"]));
  assert.equal(out.find((r) => r.key === "p1")!.removed, false);
  assert.equal(out.find((r) => r.key === "p2")!.removed, true);
});

// ── remove empty rows (empty NEW rows only) ──────────────────────────────────

test("removeEmptyRows: drops only blank NEW rows; keeps filled new rows and all persisted", () => {
  const rows = [
    fresh("blank"),                              // empty new → drop
    fresh("hasName", { variant_name: "أحمر" }),  // new with data → keep
    persisted("p-blank", { variant_name: "", sku: "", barcode: "", price: "", stock_quantity: "" }, "id-p"), // persisted blank → keep
    persisted("p1"),                             // persisted → keep
  ];
  const out = removeEmptyRows(rows);
  assert.deepEqual(out.map((r) => r.key), ["hasName", "p-blank", "p1"]);
});

// ── duplicateRow: identity cleared ───────────────────────────────────────────

test("duplicateRow: copies data but CLEARS sku/barcode and is a new row", () => {
  const rows = [persisted("p1", { variant_name: "وردي", sku: "mk9-1", barcode: "4006381333931", price: "15", stock_quantity: "4" })];
  const out = duplicateRow(rows, "p1", "new-9");
  assert.equal(out.length, 2);
  const dup = out[1];
  assert.equal(dup.key, "new-9");
  assert.equal(dup.id, null); // never copies the persisted id
  assert.equal(dup.fields.variant_name, "وردي"); // data copied
  assert.equal(dup.fields.price, "15");
  assert.equal(dup.fields.sku, ""); // identity cleared
  assert.equal(dup.fields.barcode, "");
  assert.deepEqual(duplicateRow(rows, "absent", "n").map((r) => r.key), ["p1"]); // no-op on missing
});

// ── selection uses stable keys, not array index ──────────────────────────────

test("selection is by stable row key, unaffected by array position", () => {
  const rows = [fresh("k-A"), persisted("k-B"), fresh("k-C")];
  const out = setSelectedPrice(rows, new Set(["k-B"]), "50");
  // The right row (k-B) is the one changed, regardless of its index.
  assert.equal(out.find((r) => r.key === "k-B")!.fields.price, "50");
  assert.equal(out.find((r) => r.key === "k-A")!.fields.price, "");
});

// ── immutability: inputs never mutated ───────────────────────────────────────

test("no mutation: every op returns a new array and leaves the input untouched", () => {
  const rows = [persisted("a"), fresh("b", { price: "" })];
  const before = snapshot(rows);
  fillMissingPrice(rows, "9");
  fillMissingStock(rows, "9");
  setSelectedPrice(rows, new Set(["a"]), "9");
  setSelectedStock(rows, new Set(["a"]), "9");
  addRows(rows, 2, (i) => `n${i}`);
  duplicateRow(rows, "a", "z");
  markSelectedRemoved(rows, new Set(["a"]));
  restoreSelected(rows, new Set(["a"]));
  removeEmptyRows(rows);
  generateMissingSkus("mk9", rows);
  assert.equal(snapshot(rows), before, "input array + rows unchanged");
});

// ── source guards: shared reuse, purity, no duplicated logic ─────────────────

test("guard: Create and Edit both drive the SAME shared bulk layer + component", () => {
  for (const rel of [
    "../../components/v2/catalog/AiProductCreator.tsx",
    "../../components/v2/catalog/ProductEditForm.tsx",
  ]) {
    const code = read(rel);
    assert.ok(code.includes('from "@/lib/products/variant-bulk"'), `${rel} imports the pure bulk layer`);
    assert.ok(code.includes("VariantBulkTools"), `${rel} renders the shared bulk tools`);
  }
});

test("guard: variant-bulk is pure — no React/Supabase/server/browser imports", () => {
  const code = read("./variant-bulk.ts");
  for (const forbidden of ['from "react"', "supabase", '"use client"', "next/", "window.", "document."]) {
    assert.equal(code.includes(forbidden), false, `variant-bulk must not contain ${forbidden}`);
  }
  // It reuses the shared layers rather than reimplementing them.
  assert.ok(code.includes('from "./variant-model.ts"'), "composes variant-model");
  assert.ok(code.includes('from "./variant-validate.ts"'), "uses the shared count predicate");
});

test("guard: VariantBulkTools reimplements NO validation/SKU/barcode logic", () => {
  const code = read("../../components/v2/catalog/VariantBulkTools.tsx");
  for (const forbidden of ["isValidEan13", "isValidMkSku", "validateProduct", "/^mk", "/^\\d{13}", "seenSkus"]) {
    assert.equal(code.includes(forbidden), false, `VariantBulkTools must not inline ${forbidden}`);
  }
  // Its only shared-logic dependency is the count predicate.
  assert.ok(code.includes("withinAddBatchLimit"), "delegates the count guard to the shared predicate");
});

test("guard: the pure bulk layer performs no DB / RPC / server writes", () => {
  const code = read("./variant-bulk.ts");
  for (const forbidden of ["rpc(", ".insert(", ".update(", "saveProduct", "createClient", "fetch("]) {
    assert.equal(code.includes(forbidden), false, `variant-bulk must not ${forbidden}`);
  }
});
