// UX.4E-2 regression + guard suite. Proves the shared variant-model row
// transforms (adopted by Create and Edit via useVariantIdentity) produce output
// IDENTICAL to the pre-refactor inline logic, and that the duplicated generator
// blocks did not come back. PURE: no DB, no network, no React.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/variant-identity-refactor.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  makeVariantRow,
  removeVariantRow,
  applyMissingVariantSkus,
  applyMissingVariantBarcodes,
  applyAllMissingVariantIdentity,
  applyProductPriceToEmptyVariants,
  renumberVariantRowSkus,
  type VariantRowModel,
} from "./variant-model.ts";
import {
  copyProductPriceToEmpty,
  fillMissingVariantBarcodes,
  fillMissingVariantSkus,
  generateAllMissingIdentity,
} from "./identity-fill.ts";
import { renumberVariantSkus } from "./sku-generate.ts";
import { buildVariantInputs } from "./edit-form-state.ts";

// Deterministic, repeatable "random" so oracle and new impl consume the SAME
// sequence. Returns a FRESH generator each call.
function freshRandom(): () => number {
  let n = 0.123456;
  return () => {
    n = (n * 9301 + 0.49297) % 1;
    return n;
  };
}

function rowsOf(specs: Array<Partial<VariantRowModel["fields"]> & { removed?: boolean; id?: string }>): VariantRowModel[] {
  return specs.map((s, i) => {
    const r = makeVariantRow(`k${i}`, { id: s.id ?? null, fields: s });
    return s.removed ? { ...r, removed: true } : r;
  });
}

// ── ORACLES: the exact pre-refactor inline logic, transcribed onto model rows ──

function oracleMissingSkus(mainSku: string, rows: readonly VariantRowModel[]): VariantRowModel[] {
  const active = rows.filter((r) => !r.removed);
  const skus = fillMissingVariantSkus(mainSku, active.map((r) => ({ sku: r.fields.sku })));
  let k = -1;
  return rows.map((r) => (r.removed ? r : (++k, { ...r, fields: { ...r.fields, sku: skus[k] } })));
}
function oracleMissingBarcodes(rows: readonly VariantRowModel[], existing: Set<string>, random: () => number, extra: string[]): VariantRowModel[] {
  const active = rows.filter((r) => !r.removed);
  const bcs = fillMissingVariantBarcodes(active.map((r) => ({ barcode: r.fields.barcode })), existing, random, extra);
  let k = -1;
  return rows.map((r) => (r.removed ? r : (++k, { ...r, fields: { ...r.fields, barcode: bcs[k] } })));
}
function oracleAll(mainSku: string, rows: readonly VariantRowModel[], existing: Set<string>, random: () => number, extra: string[]): VariantRowModel[] {
  const active = rows.filter((r) => !r.removed);
  const out = generateAllMissingIdentity(mainSku, active.map((r) => ({ sku: r.fields.sku, barcode: r.fields.barcode })), existing, random, extra);
  let k = -1;
  return rows.map((r) => (r.removed ? r : (++k, { ...r, fields: { ...r.fields, sku: out.skus[k], barcode: out.barcodes[k] } })));
}
function oraclePrice(price: string, rows: readonly VariantRowModel[]): VariantRowModel[] {
  const active = rows.filter((r) => !r.removed);
  const prices = copyProductPriceToEmpty(price, active.map((r) => ({ price: r.fields.price })));
  let k = -1;
  return rows.map((r) => (r.removed ? r : (++k, { ...r, fields: { ...r.fields, price: prices[k] } })));
}
function oracleRenumber(mainSku: string, rows: readonly VariantRowModel[]): VariantRowModel[] {
  const count = rows.filter((r) => !r.removed).length;
  const skus = renumberVariantSkus(mainSku, count);
  let k = -1;
  return rows.map((r) => (r.removed ? r : (++k, { ...r, fields: { ...r.fields, sku: skus[k] } })));
}

// Row sets: create-style (no removed) AND edit-style (with removed).
const CREATE_ROWS = rowsOf([
  { variant_name: "أحمر", sku: "", barcode: "" },
  { variant_name: "أزرق", sku: "mk9-2", barcode: "1234567890128" },
  { variant_name: "أخضر", sku: "", barcode: "" },
]);
const EDIT_ROWS = removeVariantRow(
  rowsOf([
    { id: "u1", variant_name: "أحمر", sku: "mk9-1", barcode: "1111111111116", price: "10" },
    { id: "u2", variant_name: "أزرق", sku: "", barcode: "", price: "" },
    { id: "u3", variant_name: "أخضر", sku: "", barcode: "", price: "" },
  ]),
  "k1", // soft-remove the middle existing row
);

// ── equivalence tests ────────────────────────────────────────────────────────

for (const [label, rows, mainSku] of [
  ["create (no removed)", CREATE_ROWS, "mk9"],
  ["edit (with removed)", EDIT_ROWS, "mk9"],
] as const) {
  test(`applyMissingVariantSkus matches the old inline logic — ${label}`, () => {
    assert.deepEqual(applyMissingVariantSkus(mainSku, rows), oracleMissingSkus(mainSku, rows));
  });

  test(`applyMissingVariantBarcodes matches the old inline logic — ${label}`, () => {
    const existingA = new Set<string>(["9999999999994"]);
    const existingB = new Set<string>(["9999999999994"]);
    assert.deepEqual(
      applyMissingVariantBarcodes(rows, existingA, freshRandom(), ["1010101010105"]),
      oracleMissingBarcodes(rows, existingB, freshRandom(), ["1010101010105"]),
    );
  });

  test(`applyAllMissingVariantIdentity matches the old inline logic — ${label}`, () => {
    assert.deepEqual(
      applyAllMissingVariantIdentity(mainSku, rows, new Set(["9999999999994"]), freshRandom(), ["1010101010105"]),
      oracleAll(mainSku, rows, new Set(["9999999999994"]), freshRandom(), ["1010101010105"]),
    );
  });

  test(`applyProductPriceToEmptyVariants matches the old inline logic — ${label}`, () => {
    assert.deepEqual(applyProductPriceToEmptyVariants("25", rows), oraclePrice("25", rows));
  });

  test(`renumberVariantRowSkus (copy-prefix) matches the old inline logic — ${label}`, () => {
    assert.deepEqual(renumberVariantRowSkus(mainSku, rows), oracleRenumber(mainSku, rows));
  });
}

// Removed rows are never touched by any transform.
test("transforms leave soft-removed rows byte-for-byte unchanged", () => {
  const removedRow = EDIT_ROWS.find((r) => r.removed)!;
  for (const out of [
    applyMissingVariantSkus("mk9", EDIT_ROWS),
    applyProductPriceToEmptyVariants("25", EDIT_ROWS),
    renumberVariantRowSkus("mk9", EDIT_ROWS),
  ]) {
    assert.equal(out.find((r) => r.key === removedRow.key), removedRow, "same object reference");
  }
});

// buildVariantInputs over create rows == the old inline create mapping.
test("buildVariantInputs reproduces the old create buildInput variant mapping", () => {
  const oldMapping = CREATE_ROWS.map((r) => ({
    variant_name: r.fields.variant_name,
    variant_name_en: r.fields.variant_name_en,
    sku: r.fields.sku,
    barcode: r.fields.barcode,
    color: r.fields.color,
    size: r.fields.size,
    price: r.fields.price,
    stock_quantity: r.fields.stock_quantity,
  }));
  assert.deepEqual(buildVariantInputs(CREATE_ROWS), oldMapping);
});

// ── source guards: the duplicated generator blocks must not come back ─────────

function src(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}
const CREATE = src("../../components/v2/catalog/AiProductCreator.tsx");
const EDIT = src("../../components/v2/catalog/ProductEditForm.tsx");
const HOOK = src("../../components/v2/catalog/useVariantIdentity.ts");

test("both editors adopt the shared hook + variant-model reducers", () => {
  for (const [name, code] of [["create", CREATE], ["edit", EDIT]] as const) {
    assert.ok(code.includes('from "@/components/v2/catalog/useVariantIdentity"'), `${name} imports the hook`);
    assert.ok(code.includes("useVariantIdentity({"), `${name} calls the hook`);
    assert.ok(code.includes("addVariantRow") && code.includes("removeVariantRow") && code.includes("updateVariantField"),
      `${name} uses the shared reducers`);
  }
});

test("neither editor still contains the duplicated generator / orchestration logic", () => {
  const banned = [
    "fillMissingVariantSkus",
    "fillMissingVariantBarcodes",
    "generateAllMissingIdentity",
    "copyProductPriceToEmpty",
    "loadCatalogIdentity",
    "ensureIdentity",
    "nextMainSku",
    "nextMainBarcode",
  ];
  for (const [name, code] of [["create", CREATE], ["edit", EDIT]] as const) {
    for (const token of banned) {
      assert.equal(code.includes(token), false, `${name} must not inline ${token} (moved to the hook/model)`);
    }
  }
});

test("the hook is orchestration-only: no duplicated fill logic, delegates to variant-model", () => {
  assert.ok(HOOK.includes('from "@/lib/products/variant-model"'), "hook imports the pure row transforms");
  for (const token of ["fillMissingVariantSkus", "fillMissingVariantBarcodes", "generateAllMissingIdentity", "copyProductPriceToEmpty"]) {
    assert.equal(HOOK.includes(token), false, `hook must not re-implement ${token} (lives in variant-model)`);
  }
});
