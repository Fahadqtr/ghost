// Tests for duplicate detection (Phase UI.5, card revision). PURE.
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
    productId: "p1",
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

// ── normalization ────────────────────────────────────────────────────────────

test("normalization: lowercase, symbols/spaces stripped, Arabic digits and ml unified", () => {
  assert.equal(normalizeIdentity("COSRX Snail-Mucin  96 ML."), normalizeIdentity("cosrx snail mucin 96ml"));
  assert.equal(normalizeIdentity("٩٦ مل"), "96ml");
  assert.equal(normalizeIdentity("A&B (50ml)"), "ab50ml");
  assert.equal(normalizeIdentity(null), "");
});

test("identityTokens keeps meaningful normalized words only", () => {
  assert.deepEqual(identityTokens("Cosrx  Snail! Mucin 96ml"), ["cosrx", "snail", "mucin", "96ml"]);
});

// ── exact matches ────────────────────────────────────────────────────────────

test("same SKU (case-insensitive) is an EXACT product match", () => {
  const report = findDuplicates(candidate({ sku: "MK10" }), [row()]);
  assert.equal(report.level, "exact");
  assert.equal(report.matches[0].productId, "p1");
  assert.ok(report.matches[0].reasons.includes("same_sku"));
});

test("a barcode hit on a VARIANT rolls up into its PARENT product", () => {
  const report = findDuplicates(candidate({ barcodes: ["4006381333931"] }), [
    row({ kind: "variant", id: "v1", productId: "p-parent", sku: "mk10-1", nameEn: "Pink", nameAr: null }),
  ]);
  assert.equal(report.level, "exact");
  assert.equal(report.matches[0].productId, "p-parent", "the card is the parent product, not the variant");
  assert.ok(report.matches[0].reasons.includes("same_barcode"));
});

test("same normalized brand+name+size identity is EXACT even with different spelling", () => {
  const report = findDuplicates(
    candidate({ brand: "COSRX", nameEn: "Snail Mucin Essence", size: "٩٦ مل" }),
    [row({ nameEn: "Cosrx Snail-Mucin Essence", size: "96ML" })],
  );
  assert.equal(report.level, "exact");
  assert.ok(report.matches[0].reasons.includes("same_identity"));
});

// ── aggregation: the "Pink ×5" bug ───────────────────────────────────────────

test("multiple matching rows of ONE product merge into ONE match with merged reasons", () => {
  const rows: IdentityRow[] = [
    row({ id: "p1", productId: "p1", nameEn: "Cosrx Snail Mucin Essence", size: "96ml" }),
    row({ id: "v1", kind: "variant", productId: "p1", sku: "mk10-1", barcode: "111", nameEn: "Cosrx Snail Mucin Essence Pink" }),
    row({ id: "v2", kind: "variant", productId: "p1", sku: "mk10-2", barcode: "222", nameEn: "Cosrx Snail Mucin Essence Blue" }),
    row({ id: "v3", kind: "variant", productId: "p1", sku: "mk10-3", barcode: "333", nameEn: "Cosrx Snail Mucin Essence Red" }),
  ];
  const report = findDuplicates(candidate({ sku: "mk99", nameEn: "Cosrx Snail Mucin Essence" }), rows);
  assert.equal(report.matches.length, 1, "one card per product — never five repeated lines");
  assert.equal(report.matches[0].productId, "p1");
  const reasons = report.matches[0].reasons;
  assert.equal([...new Set(reasons)].length, reasons.length, "reasons are unique");
  assert.ok(reasons.includes("similar_name"));
});

test("secondary reasons (brand/size) merge onto the same product card", () => {
  const report = findDuplicates(
    candidate({ brand: "Cosrx", nameEn: "Cosrx Snail Mucin Essence", size: "96ml", sku: "mk99" }),
    [row({ nameEn: "Cosrx Snail Mucin Essence 96ml" })],
  );
  const m = report.matches[0];
  assert.ok(m.reasons.includes("same_brand"), "brand merged");
  assert.ok(m.reasons.includes("same_size"), "size merged");
});

// ── qualification rules ──────────────────────────────────────────────────────

test("sharing only a size is noise — not similar", () => {
  const report = findDuplicates(
    candidate({ brand: "Rhode", nameEn: "Peptide Lip Tint", size: "96ml" }),
    [row({ nameEn: "Cosrx Snail Mucin Essence", size: "96ml" })],
  );
  assert.equal(report.level, "none");
});

test("brand + size without a similar name IS reported as similar (warning only)", () => {
  const report = findDuplicates(
    candidate({ brand: "Cosrx", nameEn: "Totally Different Product", size: "96ml" }),
    [row({ nameEn: "Cosrx Snail Mucin Essence", size: "96ml" })],
  );
  assert.equal(report.level, "similar");
  assert.ok(report.matches[0].reasons.includes("same_brand"));
  assert.ok(report.matches[0].reasons.includes("same_size"));
});

test("high name overlap without identical identity is only SIMILAR — it never blocks", () => {
  const report = findDuplicates(
    candidate({ nameEn: "Cosrx Snail Mucin Essence", size: "50ml" }),
    [row({ size: "96ml", nameEn: "Cosrx Snail Mucin Essence 96ml" })],
  );
  assert.equal(report.level, "similar");
  assert.ok(report.matches[0].reasons.includes("similar_name"));
});

test("an unrelated catalog stays NONE", () => {
  const report = findDuplicates(candidate(), [
    row({ id: "x", productId: "x", sku: "mk55", barcode: "1112223334445", nameEn: "Rhode Lip Tint", nameAr: "رود", size: null }),
  ]);
  assert.equal(report.level, "none");
  assert.deepEqual(report.matches, []);
  assert.equal(report.total, 0);
});

// ── ordering + cap ───────────────────────────────────────────────────────────

test("exact products sort before similar ones; the cap keeps total honest", () => {
  const rows: IdentityRow[] = [
    row({ id: "sim1", productId: "sim1", sku: "mk20", barcode: "b1", nameEn: "Cosrx Snail Mucin Essence Set" }),
    row({ id: "ex1", productId: "ex1", sku: "mk99", barcode: "b2", nameEn: "Unrelated Thing" }), // same sku as candidate
    row({ id: "sim2", productId: "sim2", sku: "mk21", barcode: "b3", nameEn: "Cosrx Snail Mucin Essence Duo", size: "96ml" }),
  ];
  const report = findDuplicates(candidate({ sku: "mk99", brand: "Cosrx", nameEn: "Cosrx Snail Mucin Essence" }), rows, 2);
  assert.equal(report.matches[0].productId, "ex1", "exact first");
  assert.equal(report.matches.length, 2, "capped");
  assert.equal(report.total, 3, "total counts everything found");
});

test("similar products order by descending merged score", () => {
  const rows: IdentityRow[] = [
    row({ id: "weak", productId: "weak", sku: "mk30", barcode: "b4", nameEn: "Cosrx Snail Mucin Essence", size: null }),
    row({ id: "strong", productId: "strong", sku: "mk31", barcode: "b5", nameEn: "Cosrx Snail Mucin Essence", size: "96ml" }),
  ];
  const report = findDuplicates(candidate({ brand: "Cosrx", nameEn: "Cosrx Snail Mucin Essence" }), rows);
  assert.equal(report.matches[0].productId, "strong", "more merged reasons -> higher score -> first");
  assert.ok(report.matches[0].score > report.matches[1].score);
});

test("rows without a productId are skipped, never invented", () => {
  const report = findDuplicates(candidate({ sku: "mk10" }), [row({ productId: "" })]);
  assert.equal(report.matches.length, 0);
});
