// UX.4E-7 — pure per-variant completeness. Deterministic, read-only. Proves the
// required/optional split, status semantics, percent, removed-row exclusion, and
// the aggregate summary. PURE — no DB, no network, no React. Run:
//   node --conditions=react-server --experimental-strip-types --test lib/products/variant-completeness.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  computeVariantCompleteness,
  summarizeVariantCompleteness,
  type VariantCheckKey,
} from "./variant-completeness.ts";
import { makeVariantRow, type VariantRowModel } from "./variant-model.ts";

const GOOD_BARCODE = "4006381333931";
const MAIN = "mk9";

function row(over: Partial<VariantRowModel["fields"]> = {}, opts: { id?: string | null; removed?: boolean } = {}): VariantRowModel {
  const r = makeVariantRow("k", {
    id: opts.id ?? null,
    fields: { variant_name: "وردي", sku: "mk9-1", barcode: GOOD_BARCODE, price: "10", stock_quantity: "3", ...over },
  });
  return opts.removed ? { ...r, removed: true } : r;
}

function stateOf(rw: VariantRowModel, key: VariantCheckKey) {
  return computeVariantCompleteness(rw, MAIN).checks.find((c) => c.key === key)!.state;
}

// ── a fully complete row ─────────────────────────────────────────────────────

test("complete row: all required checks pass → complete, 100%", () => {
  const c = computeVariantCompleteness(row(), MAIN);
  assert.equal(c.status, "complete");
  assert.equal(c.percent, 100);
  assert.deepEqual(c.missing, []);
  assert.deepEqual(c.invalid, []);
});

// ── required: missing vs invalid ─────────────────────────────────────────────

test("missing name → incomplete, name in missing[]", () => {
  const c = computeVariantCompleteness(row({ variant_name: "", variant_name_en: "" }), MAIN);
  assert.equal(c.status, "incomplete");
  assert.ok(c.missing.includes("name"));
  assert.equal(c.percent, 80); // 4/5
});

test("missing SKU → incomplete; invalid SKU → invalid", () => {
  assert.equal(stateOf(row({ sku: "" }), "sku"), "missing");
  assert.equal(computeVariantCompleteness(row({ sku: "" }), MAIN).status, "incomplete");
  assert.equal(stateOf(row({ sku: "nope" }), "sku"), "invalid");
  assert.equal(computeVariantCompleteness(row({ sku: "nope" }), MAIN).status, "invalid");
  // a valid variant SKU for a DIFFERENT main is invalid here
  assert.equal(stateOf(row({ sku: "mk8-1" }), "sku"), "invalid");
});

test("missing barcode → incomplete; invalid EAN → invalid", () => {
  assert.equal(stateOf(row({ barcode: "" }), "barcode"), "missing");
  assert.equal(stateOf(row({ barcode: "4006381333930" }), "barcode"), "invalid"); // bad check digit
  assert.equal(stateOf(row({ barcode: "123" }), "barcode"), "invalid");
});

test("missing price → incomplete; negative/junk price → invalid", () => {
  assert.equal(stateOf(row({ price: "" }), "price"), "missing");
  assert.equal(stateOf(row({ price: "-5" }), "price"), "invalid");
  assert.equal(stateOf(row({ price: "abc" }), "price"), "invalid");
  assert.equal(stateOf(row({ price: "0" }), "price"), "ok"); // zero is valid
});

test("missing stock → incomplete; negative/junk stock → invalid", () => {
  assert.equal(stateOf(row({ stock_quantity: "" }), "stock"), "missing");
  assert.equal(stateOf(row({ stock_quantity: "-1" }), "stock"), "invalid");
  assert.equal(stateOf(row({ stock_quantity: "x" }), "stock"), "invalid");
});

test("invalid takes precedence over missing for overall status", () => {
  const c = computeVariantCompleteness(row({ variant_name: "", variant_name_en: "", sku: "bad" }), MAIN);
  assert.equal(c.status, "invalid"); // sku invalid dominates the missing name
});

// ── optional fields never block ──────────────────────────────────────────────

test("optional color/size/second-name do not affect percent or status", () => {
  const c = computeVariantCompleteness(row({ color: "", size: "", variant_name_en: "" }), MAIN);
  assert.equal(c.status, "complete"); // required all pass
  assert.equal(c.percent, 100);
  // optional checks still reported for display
  assert.equal(c.checks.find((x) => x.key === "color")!.required, false);
  assert.equal(c.checks.find((x) => x.key === "color")!.state, "missing");
  assert.equal(c.checks.find((x) => x.key === "size")!.required, false);
});

// ── removed rows ─────────────────────────────────────────────────────────────

test("removed row → status 'removed', empty checklist", () => {
  const c = computeVariantCompleteness(row({}, { id: "db-1", removed: true }), MAIN);
  assert.equal(c.status, "removed");
  assert.deepEqual(c.checks, []);
});

// ── aggregate summary ────────────────────────────────────────────────────────

test("summary: deterministic counts + percent over ACTIVE rows only", () => {
  const rows: VariantRowModel[] = [
    { ...row(), key: "a" },                                         // complete
    { ...row({ price: "" }), key: "b" },                           // incomplete (4/5)
    { ...row({ barcode: "123" }), key: "c" },                      // invalid (4/5)
    { ...row({}, { id: "db-x", removed: true }), key: "d" },       // removed → excluded
  ];
  const s = summarizeVariantCompleteness(rows, MAIN);
  assert.equal(s.activeCount, 3);
  assert.equal(s.completeCount, 1);
  assert.equal(s.incompleteCount, 1);
  assert.equal(s.invalidCount, 1);
  assert.equal(s.needsAttention, true);
  // required checks: a 5/5, b 4/5, c 4/5 → 13/15 → 87
  assert.equal(s.percent, Math.round((13 / 15) * 100));
});

test("summary: no active rows → 100% and no attention needed", () => {
  const s = summarizeVariantCompleteness([{ ...row({}, { id: "db-1", removed: true }), key: "a" }], MAIN);
  assert.equal(s.activeCount, 0);
  assert.equal(s.percent, 100);
  assert.equal(s.needsAttention, false);
});

test("summary is deterministic (same input → same output)", () => {
  const rows = [{ ...row(), key: "a" }, { ...row({ sku: "" }), key: "b" }];
  assert.deepEqual(summarizeVariantCompleteness(rows, MAIN), summarizeVariantCompleteness(rows, MAIN));
});

// ── no mutation ──────────────────────────────────────────────────────────────

test("no mutation: inputs are never mutated", () => {
  const rows = [{ ...row(), key: "a" }, { ...row({ price: "" }), key: "b" }];
  const before = JSON.stringify(rows);
  computeVariantCompleteness(rows[0], MAIN);
  summarizeVariantCompleteness(rows, MAIN);
  assert.equal(JSON.stringify(rows), before);
});

// ── source guards ────────────────────────────────────────────────────────────

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

test("guard: completeness is pure and reuses variant-validate + variant-model", () => {
  const code = read("./variant-completeness.ts");
  for (const forbidden of ['from "react"', "supabase", '"use client"', '"use server"', "fetch(", "Date.now", "Math.random", ".insert(", ".update(", "rpc("]) {
    assert.equal(code.includes(forbidden), false, `variant-completeness must not contain ${forbidden}`);
  }
  assert.ok(code.includes('from "./variant-validate.ts"'), "reuses variant-validate primitives");
  assert.ok(code.includes('from "./variant-model.ts"'), "reuses variant-model (activeVariantRows)");
});

test("guard: completeness does NOT reimplement SKU/barcode/number rules", () => {
  const code = read("./variant-completeness.ts");
  for (const forbidden of ["/^mk", "/^\\d{13}", "ean13CheckDigit", "Number.isFinite", "new RegExp"]) {
    assert.equal(code.includes(forbidden), false, `variant-completeness must not inline ${forbidden}`);
  }
});

test("guard: Create AND Edit both use the shared completeness component + helper", () => {
  for (const rel of [
    "../../components/v2/catalog/AiProductCreator.tsx",
    "../../components/v2/catalog/ProductEditForm.tsx",
  ]) {
    const code = read(rel);
    assert.ok(code.includes("VariantCompleteness"), `${rel} renders the shared component`);
  }
  const comp = read("../../components/v2/catalog/VariantCompleteness.tsx");
  assert.ok(comp.includes("summarizeVariantCompleteness"), "component uses the shared summary helper");
});
