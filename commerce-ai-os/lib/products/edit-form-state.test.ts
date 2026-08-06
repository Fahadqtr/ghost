// Tests for the V2 product-editor row-state helpers (Phase UI.4). These are
// the exact functions the client form uses to build its payload, so what is
// proven here is what the browser sends.
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/edit-form-state.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildVariantInputs,
  EMPTY_VARIANT_FIELDS,
  hasUnsavedChanges,
  toVariantRows,
  type VariantRowState,
} from "./edit-form-state.ts";

const FIELDS = {
  variant_name: "وردي",
  variant_name_en: "Pink",
  sku: "V-1",
  barcode: "111",
  color: "pink",
  size: "M",
  price: "35",
  stock_quantity: "4",
};

function existingRow(id: string, over: Partial<VariantRowState> = {}): VariantRowState {
  return { key: id, id, removed: false, fields: { ...FIELDS }, ...over };
}

function newRow(n: number, over: Partial<VariantRowState> = {}): VariantRowState {
  return { key: `new-${n}`, id: null, removed: false, fields: { ...EMPTY_VARIANT_FIELDS, sku: `N-${n}` }, ...over };
}

// ── toVariantRows ────────────────────────────────────────────────────────────

test("toVariantRows: keeps the database uuid verbatim as both id and React key", () => {
  const rows = toVariantRows([{ id: "11111111-2222-3333-4444-555555555555", ...FIELDS }]);
  assert.equal(rows[0].id, "11111111-2222-3333-4444-555555555555");
  assert.equal(rows[0].key, "11111111-2222-3333-4444-555555555555");
  assert.equal(rows[0].removed, false);
});

// ── buildVariantInputs: the payload identity rules ───────────────────────────

test("payload: an existing row sends its database id verbatim", () => {
  const out = buildVariantInputs([existingRow("va")]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "va");
});

test("payload: a new row sends NO id key at all — no client-generated uuid, no React key", () => {
  const out = buildVariantInputs([newRow(3)]);
  assert.equal(out.length, 1);
  assert.ok(!("id" in out[0]), "no id property on a new row");
  assert.ok(!JSON.stringify(out).includes("new-3"), "the local React key never leaks into the payload");
});

test("payload: a removed existing row is omitted entirely (the RPC decides the delete)", () => {
  const out = buildVariantInputs([existingRow("va", { removed: true }), existingRow("vb")]);
  assert.deepEqual(out.map((v) => v.id), ["vb"]);
});

test("payload: field values are carried as-is, order follows the rows", () => {
  const out = buildVariantInputs([existingRow("va"), newRow(1)]);
  assert.equal(out[0].sku, "V-1");
  assert.equal(out[1].sku, "N-1");
});

test("payload: editing every field of an existing row still keeps the same id (no delete-and-recreate)", () => {
  const edited = existingRow("va");
  edited.fields = { ...edited.fields, sku: "TOTALLY-NEW", barcode: "999", price: "1" };
  const out = buildVariantInputs([edited]);
  assert.equal(out[0].id, "va");
  assert.equal(out[0].sku, "TOTALLY-NEW");
});

// ── hasUnsavedChanges ────────────────────────────────────────────────────────

test("dirty tracking: pristine state is clean; scalar edits, row edits, removals and additions are dirty", () => {
  const scalars = { name_ar: "سيروم", price: "120" };
  const rows = [existingRow("va")];
  assert.equal(hasUnsavedChanges(scalars, { ...scalars }, rows, [existingRow("va")]), false);
  assert.equal(hasUnsavedChanges(scalars, { ...scalars, price: "121" }, rows, [existingRow("va")]), true);
  const edited = existingRow("va");
  edited.fields = { ...edited.fields, sku: "X" };
  assert.equal(hasUnsavedChanges(scalars, { ...scalars }, rows, [edited]), true);
  assert.equal(hasUnsavedChanges(scalars, { ...scalars }, rows, [existingRow("va", { removed: true })]), true);
  assert.equal(hasUnsavedChanges(scalars, { ...scalars }, rows, [existingRow("va"), newRow(1)]), true);
});
