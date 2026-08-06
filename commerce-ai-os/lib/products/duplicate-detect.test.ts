// Tests for duplicate detection (Phase UI.5). PURE.
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/duplicate-detect.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  findDuplicates,
  identityTokens,
  normalizeIdentity,
  type DuplicateCandidate,
  type IdentityRow,
} from "./duplicate-detect.ts";

function row(over: Partial<IdentityRow> = {}): IdentityRow {
  return {
    id: "p1",
    kind: "product",
    sku: "mk10",
    barcode: "4006381333931",
    nameEn: "Cosrx Snail Mucin Essence 96ml",
    nameAr: "كوزركس سنيل ميوسين",
    size: "96ml",
    color: null,
    ...over,
  };
}

function candidate(over: Partial<DuplicateCandidate> = {}): DuplicateCandidate {
  return {
    sku: "mk99",
    barcodes: [],
    brand: "Cosrx",
    nameEn: "Snail Mucin Essence",
    nameAr: "",
    size: "96ml",
    shade: "",
    ...over,
  };
}

test("normalization: lowercase, symbols/spaces stripped, Arabic digits and ml unified", () => {
  assert.equal(normalizeIdentity("COSRX Snail-Mucin  96 ML."), normalizeIdentity("cosrx snail mucin 96ml"));
  assert.equal(normalizeIdentity("٩٦ مل"), "96ml");
  assert.equal(normalizeIdentity("A&B (50ml)"), "ab50ml");
  assert.equal(normalizeIdentity(null), "");
});

test("identityTokens keeps meaningful normalized words only", () => {
  assert.deepEqual(identityTokens("Cosrx  Snail! Mucin 96ml"), ["cosrx", "snail", "mucin", "96ml"]);
});

test("same SKU (case-insensitive) is an EXACT match", () => {
  const report = findDuplicates(candidate({ sku: "MK10" }), [row()]);
  assert.equal(report.level, "exact");
  assert.equal(report.matches[0].reason, "same_sku");
});

test("same barcode on a VARIANT row is an EXACT match too", () => {
  const report = findDuplicates(candidate({ barcodes: ["4006381333931"] }), [
    row({ kind: "variant", id: "v1", sku: "mk10-1" }),
  ]);
  assert.equal(report.level, "exact");
  assert.equal(report.matches[0].reason, "same_barcode");
  assert.equal(report.matches[0].kind, "variant");
});

test("same normalized brand+name+size identity is EXACT even with different spelling", () => {
  const report = findDuplicates(
    candidate({ brand: "COSRX", nameEn: "Snail Mucin Essence", size: "٩٦ مل" }),
    [row({ nameEn: "Cosrx Snail-Mucin Essence", size: "96ML" })],
  );
  assert.equal(report.level, "exact");
  assert.equal(report.matches[0].reason, "same_identity");
});

test("high name overlap without identical identity is only SIMILAR — it never blocks", () => {
  const report = findDuplicates(
    candidate({ nameEn: "Cosrx Snail Mucin Essence", size: "50ml" }),
    [row({ size: "96ml", nameEn: "Cosrx Snail Mucin Essence 96ml" })],
  );
  assert.equal(report.level, "similar");
  assert.equal(report.matches[0].reason, "similar_name");
});

test("an unrelated catalog stays NONE", () => {
  const report = findDuplicates(candidate(), [
    row({ id: "x", sku: "mk55", barcode: "1112223334445", nameEn: "Rhode Lip Tint", nameAr: "رود", size: null }),
  ]);
  assert.equal(report.level, "none");
  assert.deepEqual(report.matches, []);
});

test("match labels come from catalog display fields and the list is capped", () => {
  const rows: IdentityRow[] = [];
  for (let i = 0; i < 10; i++) rows.push(row({ id: `p${i}`, sku: `mk1${i}` , nameAr: `منتج ${i}` }));
  const report = findDuplicates(candidate({ nameEn: "Cosrx Snail Mucin Essence 96ml", size: "" }), rows, 5);
  assert.ok(report.matches.length <= 5);
  for (const m of report.matches) assert.ok(m.label.length > 0);
});
