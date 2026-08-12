// UX.4E-1 — exhaustive tests for the pure variant-row model. PURE: no DB, no
// network, no React. Every reducer is checked for correct output AND for input
// immutability (inputs are deep-frozen so any mutation throws).
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/variant-model.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_VARIANT_FIELDS,
  VARIANT_FIELD_KEYS,
  makeVariantRow,
  addVariantRow,
  removeVariantRow,
  restoreVariantRow,
  updateVariantField,
  reorderVariantRows,
  activeVariantRows,
  activeVariantCount,
  isMeaningfulVariant,
  renumberVariantRowSkus,
  type VariantFields,
  type VariantRowModel,
} from "./variant-model.ts";

function deepFreeze<T>(rows: readonly T[]): readonly T[] {
  for (const r of rows as any[]) {
    Object.freeze(r);
    if (r && typeof r === "object" && r.fields) Object.freeze(r.fields);
  }
  return Object.freeze(rows);
}

function row(key: string, over: Partial<VariantRowModel> = {}): VariantRowModel {
  return makeVariantRow(key, { id: over.id ?? null, fields: over.fields });
}

// ── constants / shape ────────────────────────────────────────────────────────

test("EMPTY_VARIANT_FIELDS has all eight fields blank", () => {
  assert.deepEqual(Object.keys(EMPTY_VARIANT_FIELDS).sort(), [...VARIANT_FIELD_KEYS].sort());
  for (const k of VARIANT_FIELD_KEYS) assert.equal(EMPTY_VARIANT_FIELDS[k], "");
});

test("VARIANT_FIELD_KEYS is the stable eight-field list", () => {
  assert.deepEqual(VARIANT_FIELD_KEYS, [
    "variant_name", "variant_name_en", "sku", "barcode",
    "color", "size", "price", "stock_quantity",
  ]);
});

// ── makeVariantRow ───────────────────────────────────────────────────────────

test("makeVariantRow: defaults to a new, non-removed, blank row", () => {
  const r = makeVariantRow("k1");
  assert.equal(r.key, "k1");
  assert.equal(r.id, null);
  assert.equal(r.removed, false);
  assert.deepEqual(r.fields, EMPTY_VARIANT_FIELDS);
  assert.notEqual(r.fields, EMPTY_VARIANT_FIELDS, "fields is a fresh object, not the shared constant");
});

test("makeVariantRow: honors id + partial fields", () => {
  const r = makeVariantRow("k2", { id: "uuid-1", fields: { sku: "mk9-1", color: "red" } });
  assert.equal(r.id, "uuid-1");
  assert.equal(r.fields.sku, "mk9-1");
  assert.equal(r.fields.color, "red");
  assert.equal(r.fields.variant_name, "", "unspecified fields stay blank");
});

// ── addVariantRow ────────────────────────────────────────────────────────────

test("addVariantRow: appends and never mutates the input array", () => {
  const rows = deepFreeze([row("a")]);
  const next = addVariantRow(rows, "b");
  assert.equal(next.length, 2);
  assert.equal(next[1].key, "b");
  assert.equal(rows.length, 1, "input unchanged");
  assert.notEqual(next, rows);
});

// ── removeVariantRow ─────────────────────────────────────────────────────────

test("removeVariantRow: a NEW row (id null) is dropped", () => {
  const rows = deepFreeze([row("a"), row("b")]);
  const next = removeVariantRow(rows, "a");
  assert.deepEqual(next.map((r) => r.key), ["b"]);
  assert.equal(rows.length, 2, "input unchanged");
});

test("removeVariantRow: an EXISTING row (id set) is soft-removed, not dropped", () => {
  const rows = deepFreeze([row("a", { id: "uuid-a" }), row("b")]);
  const next = removeVariantRow(rows, "a");
  assert.equal(next.length, 2);
  assert.equal(next[0].removed, true);
  assert.equal(next[0].id, "uuid-a");
  assert.equal(rows[0].removed, false, "input unchanged");
});

test("removeVariantRow: unknown key is a no-op", () => {
  const rows = deepFreeze([row("a", { id: "x" })]);
  const next = removeVariantRow(rows, "zzz");
  assert.deepEqual(next.map((r) => ({ k: r.key, removed: r.removed })), [{ k: "a", removed: false }]);
});

// ── restoreVariantRow ────────────────────────────────────────────────────────

test("restoreVariantRow: un-removes only the matched, removed row", () => {
  const removed = removeVariantRow([row("a", { id: "x" }), row("b", { id: "y" })], "a");
  const frozen = deepFreeze(removed);
  const next = restoreVariantRow(frozen, "a");
  assert.equal(next[0].removed, false);
  assert.equal(frozen[0].removed, true, "input unchanged");
});

test("restoreVariantRow: no-op on a non-removed row", () => {
  const rows = deepFreeze([row("a", { id: "x" })]);
  const next = restoreVariantRow(rows, "a");
  assert.equal(next[0].removed, false);
});

// ── updateVariantField ───────────────────────────────────────────────────────

test("updateVariantField: sets only the target field on the target row", () => {
  const rows = deepFreeze([row("a"), row("b")]);
  const next = updateVariantField(rows, "b", "price", "12.5");
  assert.equal(next[1].fields.price, "12.5");
  assert.equal(next[0].fields.price, "", "other row untouched");
  assert.equal(next[1].fields.sku, "", "other fields untouched");
  assert.equal(rows[1].fields.price, "", "input unchanged");
});

test("updateVariantField: every field key is settable", () => {
  let rows: readonly VariantRowModel[] = [row("a")];
  for (const k of VARIANT_FIELD_KEYS) rows = updateVariantField(rows, "a", k, `v_${k}`);
  for (const k of VARIANT_FIELD_KEYS) assert.equal(rows[0].fields[k], `v_${k}`);
});

// ── reorderVariantRows ───────────────────────────────────────────────────────

test("reorderVariantRows: moves forward and backward, preserving others", () => {
  const rows = deepFreeze([row("a"), row("b"), row("c")]);
  assert.deepEqual(reorderVariantRows(rows, 0, 2).map((r) => r.key), ["b", "c", "a"]);
  assert.deepEqual(reorderVariantRows(rows, 2, 0).map((r) => r.key), ["c", "a", "b"]);
  assert.equal(rows.map((r) => r.key).join(","), "a,b,c", "input unchanged");
});

test("reorderVariantRows: no-op (copy) on equal or out-of-range indices", () => {
  const rows = deepFreeze([row("a"), row("b")]);
  for (const [f, t] of [[0, 0], [-1, 1], [0, 5], [9, 0]] as const) {
    const next = reorderVariantRows(rows, f, t);
    assert.deepEqual(next.map((r) => r.key), ["a", "b"]);
    assert.notEqual(next, rows, "returns a new array even on no-op");
  }
});

// ── active helpers ───────────────────────────────────────────────────────────

test("activeVariantRows / activeVariantCount exclude removed rows", () => {
  const rows = removeVariantRow([row("a", { id: "x" }), row("b"), row("c", { id: "z" })], "a");
  assert.deepEqual(activeVariantRows(rows).map((r) => r.key), ["b", "c"]);
  assert.equal(activeVariantCount(rows), 2);
});

// ── isMeaningfulVariant ──────────────────────────────────────────────────────

test("isMeaningfulVariant: true when name/name_en/sku present, false when blank", () => {
  const blank: VariantFields = { ...EMPTY_VARIANT_FIELDS };
  assert.equal(isMeaningfulVariant(blank), false);
  assert.equal(isMeaningfulVariant({ ...blank, variant_name: "أحمر" }), true);
  assert.equal(isMeaningfulVariant({ ...blank, variant_name_en: "Red" }), true);
  assert.equal(isMeaningfulVariant({ ...blank, sku: "mk9-1" }), true);
  assert.equal(isMeaningfulVariant({ ...blank, color: "red", size: "50ml" }), false, "color/size alone are not meaningful");
  assert.equal(isMeaningfulVariant({ ...blank, variant_name: "   " }), false, "whitespace is blank");
});

// ── renumberVariantRowSkus ───────────────────────────────────────────────────

test("renumberVariantRowSkus: assigns mk<main>-1..n across all active rows (create parity)", () => {
  const rows = deepFreeze([row("a"), row("b"), row("c")]);
  const next = renumberVariantRowSkus("mk42", rows);
  assert.deepEqual(next.map((r) => r.fields.sku), ["mk42-1", "mk42-2", "mk42-3"]);
  assert.equal(rows[0].fields.sku, "", "input unchanged");
});

test("renumberVariantRowSkus: skips removed rows and leaves their sku untouched (edit parity)", () => {
  const base = [
    row("a", { id: "x", fields: { sku: "mk42-1" } }),
    row("b", { fields: { sku: "OLD" } }),
    row("c", { id: "z", fields: { sku: "mk42-9" } }),
  ];
  const withRemoved = removeVariantRow(base, "a"); // 'a' becomes removed
  const next = renumberVariantRowSkus("mk42", deepFreeze(withRemoved));
  const byKey = Object.fromEntries(next.map((r) => [r.key, r.fields.sku]));
  assert.equal(byKey["a"], "mk42-1", "removed row keeps its old sku");
  assert.equal(byKey["b"], "mk42-1", "first active row → -1");
  assert.equal(byKey["c"], "mk42-2", "second active row → -2");
});

test("renumberVariantRowSkus: deterministic and lowercases the main sku", () => {
  const rows = [row("a"), row("b")];
  const a = renumberVariantRowSkus("MK7", rows);
  const b = renumberVariantRowSkus("MK7", rows);
  assert.deepEqual(a.map((r) => r.fields.sku), ["mk7-1", "mk7-2"]);
  assert.deepEqual(a.map((r) => r.fields.sku), b.map((r) => r.fields.sku));
});

test("renumberVariantRowSkus: empty list yields empty list", () => {
  assert.deepEqual(renumberVariantRowSkus("mk1", []), []);
});
