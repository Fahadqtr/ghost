// UX.4E-8B — validation convergence proof. The Excel import core now routes its
// field-SHAPE validation (loose barcode + numeric price rules) through the shared
// variant-validate primitives, while keeping every import-specific concern local
// (cell coercion, CLEAR/blank semantics, approval mapping, per-row errors). These
// tests prove behavior is UNCHANGED — the shared-backed path produces the same
// values/errors the prior inline logic did — and that the import stays LOOSE
// (never strict EAN-13). PURE — no DB, no network, no React.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/excel-import/validation-convergence.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  normalizeCatalogExcelRow,
  normalizeApprovalValue,
  ROW_MESSAGES,
  CLEAR_TOKEN,
  type CatalogImportField,
} from "./core.ts";
import {
  isLooseBarcode,
  isBadNumber,
  isNegativeNumber,
  isValidEan13,
  IMPORT_VALIDATION_PROFILE,
  LOOSE_BARCODE_RE,
  MAIN_SKU_RE,
  VARIANT_SKU_RE,
} from "../variant-validate.ts";

const SKU_PRICE: Partial<Record<CatalogImportField, number>> = { sku: 0, price: 1 };
const PRICE: Partial<Record<CatalogImportField, number>> = { price: 0 };
const DISCOUNT: Partial<Record<CatalogImportField, number>> = { discount_price: 0 };
const BARCODE_NAME: Partial<Record<CatalogImportField, number>> = { barcode: 0, name_ar: 1 };
const APPROVAL: Partial<Record<CatalogImportField, number>> = { approval: 0 };

function priceValue(row: ReturnType<typeof normalizeCatalogExcelRow>, field: CatalogImportField) {
  return row.values.find((v) => v.field === field);
}

// ── the IMPORT_VALIDATION_PROFILE is explicit + loose ─────────────────────────

test("IMPORT_VALIDATION_PROFILE declares the loose, non-strict contract", () => {
  assert.equal(IMPORT_VALIDATION_PROFILE.looseBarcode, true);
  assert.equal(IMPORT_VALIDATION_PROFILE.strictEan13, false);
  assert.equal(IMPORT_VALIDATION_PROFILE.barcodeShape, LOOSE_BARCODE_RE);
  assert.equal(IMPORT_VALIDATION_PROFILE.mainSkuShape, MAIN_SKU_RE);
  assert.equal(IMPORT_VALIDATION_PROFILE.variantSkuShape, VARIANT_SKU_RE);
});

// ── valid product / variant rows unchanged ────────────────────────────────────

test("valid product row: main SKU + numeric price", () => {
  const r = normalizeCatalogExcelRow(2, ["mk123", "10.5"], SKU_PRICE);
  assert.equal(r.kind, "product");
  assert.equal(r.sku, "mk123");
  assert.deepEqual(r.errors, []);
  assert.deepEqual(priceValue(r, "price"), { field: "price", value: "10.5", clear: false });
});

test("valid variant row: variant SKU parent linkage + numeric price", () => {
  const r = normalizeCatalogExcelRow(2, ["mk9-2", "25"], SKU_PRICE);
  assert.equal(r.kind, "variant");
  assert.equal(r.parentSku, "mk9");
  assert.deepEqual(r.errors, []);
  assert.deepEqual(priceValue(r, "price"), { field: "price", value: "25", clear: false });
});

// ── barcode stays LOOSE, never strict EAN-13 ──────────────────────────────────

test("loose legacy 6-digit barcode accepted", () => {
  const r = normalizeCatalogExcelRow(2, ["123456", "اسم"], BARCODE_NAME);
  assert.equal(r.barcode, "123456");
  assert.deepEqual(r.errors, []);
});

test("strict-invalid but loose-valid barcode (13-digit, bad EAN checksum) still accepted", () => {
  const bad = "1234567890123";
  assert.equal(isValidEan13(bad), false, "strict EAN rejects it");
  assert.equal(isLooseBarcode(bad), true, "loose accepts it");
  const r = normalizeCatalogExcelRow(2, [bad, "اسم"], BARCODE_NAME);
  assert.equal(r.barcode, bad);
  assert.deepEqual(r.errors, []);
});

test("out-of-range barcodes rejected exactly as before (5 short / 15 long)", () => {
  for (const bad of ["12345", "123456789012345"]) {
    const r = normalizeCatalogExcelRow(2, [bad, "اسم"], BARCODE_NAME);
    assert.equal(r.barcode, null);
    assert.ok(r.errors.includes(ROW_MESSAGES.invalid_barcode));
  }
});

// ── numeric price/discount parity vs the transcribed OLD inline logic ──────────

// Oracle = the exact pre-refactor inline numeric algorithm.
function oldPriceOutcome(field: "price" | "discount_price", raw: string): { value?: string; error?: string } {
  const n = Number(raw);
  if (!Number.isFinite(n)) return { error: field === "price" ? ROW_MESSAGES.invalid_price : ROW_MESSAGES.invalid_discount };
  if (n < 0) return { error: ROW_MESSAGES.negative_price };
  return { value: String(n) };
}

const NUMERIC_BATTERY = ["10", "10.50", "0", "1000", "1e3", "3.14159", "-5", "-0.01", "abc", "12abc", "NaN", "Infinity"];

test("price validation matches the old inline logic for every battery input", () => {
  for (const raw of NUMERIC_BATTERY) {
    const oracle = oldPriceOutcome("price", raw);
    const r = normalizeCatalogExcelRow(2, [raw], PRICE);
    if (oracle.error) {
      assert.ok(r.errors.includes(oracle.error), `price "${raw}" → error ${oracle.error}`);
      assert.equal(priceValue(r, "price"), undefined, `price "${raw}" → no value`);
    } else {
      assert.deepEqual(priceValue(r, "price"), { field: "price", value: oracle.value, clear: false }, `price "${raw}" → ${oracle.value}`);
      assert.deepEqual(r.errors, [], `price "${raw}" → no error`);
    }
  }
});

test("discount_price validation matches the old inline logic (invalid → invalid_discount)", () => {
  for (const raw of NUMERIC_BATTERY) {
    const oracle = oldPriceOutcome("discount_price", raw);
    const r = normalizeCatalogExcelRow(2, [raw], DISCOUNT);
    if (oracle.error) {
      assert.ok(r.errors.includes(oracle.error), `discount "${raw}" → ${oracle.error}`);
    } else {
      assert.deepEqual(priceValue(r, "discount_price"), { field: "discount_price", value: oracle.value, clear: false });
    }
  }
});

test("shared numeric predicates agree with the old finite/negative checks", () => {
  for (const raw of NUMERIC_BATTERY) {
    const n = Number(raw);
    assert.equal(isBadNumber(raw), !Number.isFinite(n), `isBadNumber("${raw}")`);
    assert.equal(isNegativeNumber(raw), Number.isFinite(n) && n < 0, `isNegativeNumber("${raw}")`);
  }
});

// ── blank / CLEAR semantics unchanged ─────────────────────────────────────────

test("empty cell = no change (never a value, never a wipe)", () => {
  const r = normalizeCatalogExcelRow(2, ["mk1", ""], SKU_PRICE);
  assert.equal(priceValue(r, "price"), undefined);
});

test("CLEAR token on a clearable field → clear:true empty value", () => {
  const r = normalizeCatalogExcelRow(2, [CLEAR_TOKEN], DISCOUNT);
  assert.deepEqual(priceValue(r, "discount_price"), { field: "discount_price", value: "", clear: true });
  assert.deepEqual(r.errors, []);
});

test("CLEAR token on a NON-clearable field → clear_not_allowed error", () => {
  const r = normalizeCatalogExcelRow(2, [CLEAR_TOKEN], PRICE);
  assert.ok(r.errors.includes(ROW_MESSAGES.clear_not_allowed));
  assert.equal(priceValue(r, "price"), undefined);
});

// ── approval handling unchanged (import-specific, kept local) ──────────────────

test("approval canonicalization unchanged", () => {
  assert.equal(normalizeApprovalValue("approved"), "Approved");
  assert.equal(normalizeApprovalValue("REJECTED"), "Rejected");
  assert.equal(normalizeApprovalValue("sentai"), "SentAI");
  assert.equal(normalizeApprovalValue("yes"), null);
  const ok = normalizeCatalogExcelRow(2, ["approved"], APPROVAL);
  assert.deepEqual(ok.values.find((v) => v.field === "approval"), { field: "approval", value: "Approved", clear: false });
  const bad = normalizeCatalogExcelRow(2, ["yes"], APPROVAL);
  assert.ok(bad.errors.includes(ROW_MESSAGES.invalid_approval));
});

// ── source guards ─────────────────────────────────────────────────────────────

const core = readFileSync(new URL("./core.ts", import.meta.url), "utf8");

test("source guard: import core consumes the shared validation primitives", () => {
  assert.ok(
    /import\s*\{[\s\S]*?\bisLooseBarcode\b[\s\S]*?\bisBadNumber\b[\s\S]*?\bisNegativeNumber\b[\s\S]*?\}\s*from\s*"\.\.\/variant-validate\.ts"/.test(core),
    "core imports isLooseBarcode + isBadNumber + isNegativeNumber from variant-validate",
  );
  assert.ok(core.includes("isLooseBarcode("), "core calls the loose barcode helper");
  assert.ok(core.includes("isBadNumber(") && core.includes("isNegativeNumber("), "core calls the shared numeric rules");
});

test("source guard: no duplicated shape/numeric validation remains in core", () => {
  // the removed inline numeric block used the `n` local — must be gone
  assert.equal(core.includes("Number.isFinite(n)"), false, "no inline finite check on price");
  assert.equal(core.includes("LOOSE_BARCODE_RE"), false, "core no longer references the raw barcode regex");
  // no inline grammar/barcode regex literals (converged in UX.4E-8A, still gone)
  assert.equal(core.includes("/^\\d{6,14}$/"), false, "no inline loose-barcode literal");
  assert.equal(/const\s+(MAIN_SKU_RE|VARIANT_SKU_RE|LOOSE_BARCODE_RE)\s*=/.test(core), false, "no local grammar consts");
});

test("source guard: import stays loose — no strict EAN, no editor/UI/server coupling", () => {
  assert.equal(core.includes("isValidEan13"), false, "no strict EAN-13 enforcement");
  for (const banned of ["VariantStudio", "VariantRow", 'from "react"', "useState", '"use server"', "supabase", "createClient", ".rpc("]) {
    assert.equal(core.includes(banned), false, `core must not contain ${JSON.stringify(banned)}`);
  }
});
