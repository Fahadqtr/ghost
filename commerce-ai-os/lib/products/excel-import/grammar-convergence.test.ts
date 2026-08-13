// UX.4E-8A — grammar convergence proof. Verifies the Excel import core now
// consumes the SAME grammar objects the shared variant-validate layer exports
// (single source of truth), and that import behavior is byte-for-byte unchanged:
// the SKU/barcode shapes stay intentionally LOOSE (6–14-digit barcode, mk-SKU
// shapes) so existing catalog data keeps validating exactly as before — never
// strict EAN-13. PURE — no DB, no network, no React.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/excel-import/grammar-convergence.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeCatalogExcelRow,
  detectNewCatalogRecord,
  MAIN_SKU_RE as CORE_MAIN_SKU_RE,
  VARIANT_SKU_RE as CORE_VARIANT_SKU_RE,
  type CatalogImportField,
} from "./core.ts";
import {
  MAIN_SKU_RE,
  VARIANT_SKU_RE,
  LOOSE_BARCODE_RE,
  isValidEan13,
} from "../variant-validate.ts";

// ── single source of truth: core re-exports the SAME objects ──────────────────

test("core re-exports the SAME grammar objects variant-validate defines", () => {
  assert.equal(CORE_MAIN_SKU_RE, MAIN_SKU_RE, "MAIN_SKU_RE is the shared object");
  assert.equal(CORE_VARIANT_SKU_RE, VARIANT_SKU_RE, "VARIANT_SKU_RE is the shared object");
});

// ── helpers ───────────────────────────────────────────────────────────────────

const SKU_ONLY: Partial<Record<CatalogImportField, number>> = { sku: 0 };
const BARCODE_NAME: Partial<Record<CatalogImportField, number>> = { barcode: 0, name_ar: 1 };

// ── SKU recognition parity (via the row normalizer) ───────────────────────────

test("valid main SKU → kind product, no errors", () => {
  const r = normalizeCatalogExcelRow(2, ["mk123"], SKU_ONLY);
  assert.equal(r.kind, "product");
  assert.equal(r.sku, "mk123");
  assert.equal(r.parentSku, null);
  assert.deepEqual(r.errors, []);
});

test("MK123 upper-case is normalized to mk123 (unchanged recognition)", () => {
  const r = normalizeCatalogExcelRow(2, ["MK123"], SKU_ONLY);
  assert.equal(r.kind, "product");
  assert.equal(r.sku, "mk123");
  assert.deepEqual(r.errors, []);
});

test("invalid main SKU → invalid_sku error, kind unknown", () => {
  const r = normalizeCatalogExcelRow(2, ["xyz"], SKU_ONLY);
  assert.equal(r.kind, "unknown");
  assert.equal(r.sku, null);
  assert.ok(r.errors.some((e) => e.includes("SKU")), "flags invalid SKU");
});

test("valid variant SKU → kind variant + parent linkage", () => {
  const r = normalizeCatalogExcelRow(2, ["mk123-4"], SKU_ONLY);
  assert.equal(r.kind, "variant");
  assert.equal(r.sku, "mk123-4");
  assert.equal(r.parentSku, "mk123");
  assert.deepEqual(r.errors, []);
});

test("invalid variant SKU (mk123-0) → invalid_sku (n must be >= 1)", () => {
  const r = normalizeCatalogExcelRow(2, ["mk123-0"], SKU_ONLY);
  assert.equal(r.kind, "unknown");
  assert.ok(r.errors.length > 0, "flags invalid variant SKU");
});

// ── barcode parity — LOOSE, never strict EAN-13 ───────────────────────────────

test("loose 6-digit barcode accepted", () => {
  const r = normalizeCatalogExcelRow(2, ["123456", "اسم"], BARCODE_NAME);
  assert.equal(r.barcode, "123456");
  assert.deepEqual(r.errors, []);
});

test("loose 14-digit barcode accepted", () => {
  const r = normalizeCatalogExcelRow(2, ["12345678901234", "اسم"], BARCODE_NAME);
  assert.equal(r.barcode, "12345678901234");
  assert.deepEqual(r.errors, []);
});

test("5-digit barcode rejected (too short)", () => {
  const r = normalizeCatalogExcelRow(2, ["12345", "اسم"], BARCODE_NAME);
  assert.equal(r.barcode, null);
  assert.ok(r.errors.some((e) => e.includes("الباركود")), "flags invalid barcode");
});

test("15-digit barcode rejected (too long)", () => {
  const r = normalizeCatalogExcelRow(2, ["123456789012345", "اسم"], BARCODE_NAME);
  assert.equal(r.barcode, null);
  assert.ok(r.errors.length > 0, "flags invalid barcode");
});

test("no strict EAN behavior: a 13-digit non-EAN-checksum barcode is ACCEPTED by import", () => {
  const bad = "1234567890123"; // 13 digits, invalid EAN-13 check digit
  assert.equal(isValidEan13(bad), false, "strict EAN rejects it");
  assert.ok(LOOSE_BARCODE_RE.test(bad), "loose rule accepts it");
  const r = normalizeCatalogExcelRow(2, [bad, "اسم"], BARCODE_NAME);
  assert.equal(r.barcode, bad, "import accepts it (loose, not strict EAN)");
  assert.deepEqual(r.errors, []);
});

// ── classification parity (grammar → downstream unchanged) ────────────────────

test("classification: new variant of an EXISTING parent is unchanged", () => {
  const r = normalizeCatalogExcelRow(2, ["mk50-2"], SKU_ONLY);
  assert.equal(r.kind, "variant");
  assert.equal(r.parentSku, "mk50");
  const cls = detectNewCatalogRecord(r, "not_found", (sku) => sku === "mk50", new Set());
  assert.equal(cls.cls, "new_variant_existing_parent");
});

test("classification: orphan variant (no parent) is unchanged", () => {
  const r = normalizeCatalogExcelRow(2, ["mk777-1"], SKU_ONLY);
  const cls = detectNewCatalogRecord(r, "not_found", () => false, new Set());
  assert.equal(cls.cls, "orphan_variant");
});

test("classification: new product from a valid main SKU is unchanged", () => {
  const r = normalizeCatalogExcelRow(2, ["mk2000"], SKU_ONLY);
  assert.equal(r.kind, "product");
  const cls = detectNewCatalogRecord(r, "not_found", () => false, new Set(["mk2000"]));
  assert.equal(cls.cls, "new_product");
});
