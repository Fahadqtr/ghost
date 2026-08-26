// MALIKAS REFERENCE sheet tests — the human-readable second worksheet.
// Explanatory only: the "data" sheet stays the authoritative import contract.
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/reference.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { buildRafeeqPreview, type RafeeqPreviewProduct, type RafeeqPreviewVariant } from "./preview.ts";
import { toPackageRow, buildRafeeqXlsxAoa, primaryFilenameFor } from "./package.ts";
import {
  buildMalikasReferenceAoa,
  referenceNotes,
  MALIKAS_REFERENCE_HEADERS,
  REFERENCE_COL,
  type ReferenceItem,
} from "./reference.ts";

const PARENT_EAN = "6291041500213";
const VARIANT_EAN = "6291041500301";

function variant(id: string, sku: string, over: Partial<RafeeqPreviewVariant> = {}): RafeeqPreviewVariant {
  return { id, sku, barcode: VARIANT_EAN, nameEn: `Option ${id}`, nameAr: `خيار ${id}`, price: null, ...over };
}
function product(id: string, sku: string, over: Partial<RafeeqPreviewProduct> = {}): RafeeqPreviewProduct {
  return {
    id, sku, barcode: PARENT_EAN,
    nameEn: `Product ${sku}`, nameAr: `منتج ${sku}`,
    category: "Makeup", price: 100, discountPrice: null,
    descriptionEn: "en", descriptionAr: "ar",
    imageUrl: `https://cdn.example.com/${sku}.jpg`, imageFilename: `${sku}.jpg`,
    galleryImageUrls: [], imageCount: 1,
    lifecycleState: "ACTIVE", platformStatus: "Active",
    ...over,
  };
}
function itemsOf(products: RafeeqPreviewProduct[], kinds: Record<string, "NEW" | "OPTION_UPDATE"> = {}): ReferenceItem[] {
  return buildRafeeqPreview({ products }).rows.map((r) => ({
    row: r,
    imageFilename: primaryFilenameFor(r.sku, "jpg"),
    productIdCell: r.rafeeqId ?? "",
    kind: kinds[r.internalProductId],
  }));
}

test("the reference sheet carries EXACTLY the owner-specified 19 headers in order", () => {
  assert.deepEqual([...MALIKAS_REFERENCE_HEADERS], [
    "ROW TYPE", "SKU", "PARENT SKU", "TOTAL OPTIONS",
    "REAL BARCODE", "PRODUCT NAME EN", "PRODUCT NAME AR", "CATEGORY", "RAFEEQ CATEGORY",
    "IMAGE FILENAME", "PRODUCT PRICE", "HAS OPTIONS", "OPTION GROUP EN", "OPTION GROUP AR",
    "OPTION NAME EN", "OPTION NAME AR", "OPTION PRICE", "RAFEEQ PRODUCT ID", "NOTES",
  ]);
  const aoa = buildMalikasReferenceAoa(itemsOf([product("p1", "mk175")]));
  assert.deepEqual(aoa[0], [...MALIKAS_REFERENCE_HEADERS]);
});

test("ROW TYPE / PARENT SKU / TOTAL OPTIONS follow the owner rules exactly", () => {
  const simple = buildMalikasReferenceAoa(itemsOf([product("p1", "mk175")]))[1];
  assert.equal(simple[REFERENCE_COL.rowType], "SIMPLE PRODUCT");
  assert.equal(simple[REFERENCE_COL.parentSku], "mk175");
  assert.equal(simple[REFERENCE_COL.totalOptions], 0);

  const p = product("p1", "mk175", { variants: [
    variant("v1", "mk175-1-red", { nameEn: "Red" }),
    variant("v2", "mk175-2-gold", { nameEn: "Gold" }),
  ] });
  const rows = buildMalikasReferenceAoa(itemsOf([p])).slice(1);
  assert.deepEqual(rows.map((r) => r[REFERENCE_COL.rowType]), ["OPTION 1 OF 2", "OPTION 2 OF 2"]);
  assert.ok(rows.every((r) => r[REFERENCE_COL.parentSku] === "mk175"), "every option row names its parent SKU");
  assert.ok(rows.every((r) => r[REFERENCE_COL.totalOptions] === 2), "TOTAL OPTIONS = N on every option row");
});

test("a simple product is ONE reference row: HAS OPTIONS = NO, option cells blank, real EAN + image + category mapped", () => {
  const aoa = buildMalikasReferenceAoa(itemsOf([product("p1", "mk175")]));
  assert.equal(aoa.length, 2);
  const row = aoa[1];
  assert.equal(row[REFERENCE_COL.sku], "mk175");
  assert.equal(row[REFERENCE_COL.realBarcode], PARENT_EAN, "REAL BARCODE = the canonical EAN (reference-only)");
  assert.equal(row[REFERENCE_COL.category], "Makeup");
  assert.equal(row[REFERENCE_COL.rafeeqCategory], "Makeup");
  assert.equal(row[REFERENCE_COL.imageFilename], "mk175.jpg");
  assert.equal(row[REFERENCE_COL.productPrice], "100");
  assert.equal(row[REFERENCE_COL.hasOptions], "NO");
  for (const c of [REFERENCE_COL.groupEn, REFERENCE_COL.groupAr, REFERENCE_COL.optionEn, REFERENCE_COL.optionAr, REFERENCE_COL.optionPrice]) {
    assert.equal(row[c], "", `simple row option cell ${c} stays blank`);
  }
  assert.equal(row[REFERENCE_COL.notes], "NEW PRODUCT");
});

test("an option product repeats one reference row per option — parent fields identical, option fields varying", () => {
  const p = product("p1", "mk175", { variants: [
    variant("v1", "mk175-1-red", { nameEn: "Red", nameAr: "أحمر", price: 158 }),
    variant("v2", "mk175-2-gold", { nameEn: "Gold", nameAr: "ذهبي", price: 178 }),
  ] });
  const aoa = buildMalikasReferenceAoa(itemsOf([p]));
  assert.equal(aoa.length, 3, "header + one row per option");
  const [a, b] = [aoa[1], aoa[2]];
  for (const c of [REFERENCE_COL.sku, REFERENCE_COL.realBarcode, REFERENCE_COL.nameEn, REFERENCE_COL.nameAr,
                   REFERENCE_COL.category, REFERENCE_COL.rafeeqCategory, REFERENCE_COL.imageFilename,
                   REFERENCE_COL.productPrice, REFERENCE_COL.hasOptions, REFERENCE_COL.notes]) {
    assert.deepEqual(a[c], b[c], `parent/reference cell ${c} repeats identically`);
  }
  assert.equal(a[REFERENCE_COL.hasOptions], "YES");
  assert.equal(a[REFERENCE_COL.productPrice], "PRICE ON SELECTION", "differing prices show the sentinel");
  assert.deepEqual([a[REFERENCE_COL.optionEn], b[REFERENCE_COL.optionEn]], ["Red", "Gold"]);
  assert.deepEqual([a[REFERENCE_COL.optionPrice], b[REFERENCE_COL.optionPrice]], [158, 178], "FULL effective canonical prices");
  assert.equal(a[REFERENCE_COL.groupEn], "Options");
  assert.equal(a[REFERENCE_COL.groupAr], "الخيارات");
});

test("variant SKUs/barcodes never appear in the reference sheet; the real EAN never leaks into the data sheet", () => {
  const p = product("p1", "mk175", { variants: [variant("v1", "mk175-1-red", { nameEn: "Red" })] });
  const preview = buildRafeeqPreview({ products: [p] });
  const refCells = buildMalikasReferenceAoa(itemsOf([p])).slice(1).flatMap((r) => r.map((c) => String(c)));
  for (const cell of refCells) {
    assert.ok(!cell.includes("mk175-1-red"), "variant SKU stays internal — not on the reference sheet");
    assert.ok(!cell.includes(VARIANT_EAN), "variant barcode stays internal");
  }
  // the approved data-sheet contract is untouched: barcode = parent SKU, no EAN
  const dataCells = buildRafeeqXlsxAoa(preview.rows.map((r) => toPackageRow(r, "mk175.jpg"))).slice(1).flatMap((r) => r.map((c) => String(c)));
  for (const cell of dataCells) assert.ok(!cell.includes(PARENT_EAN), "REAL BARCODE is reference-only — never a data-sheet cell");
});

test("NOTES flags NEW PRODUCT / EXISTING PRODUCT / OPTION UPDATE / CATEGORY REVIEW correctly", () => {
  const base = buildRafeeqPreview({ products: [product("p1", "mk175")] }).rows[0];
  assert.equal(referenceNotes({ row: base, productIdCell: "" }), "NEW PRODUCT");
  assert.equal(referenceNotes({ row: base, productIdCell: "691300001" }), "EXISTING PRODUCT");
  assert.equal(referenceNotes({ row: base, productIdCell: "691300001", kind: "OPTION_UPDATE" }), "OPTION UPDATE");
  const unknownCat = buildRafeeqPreview({ products: [product("p2", "mk176", { category: "Uncategorized" })] }).rows[0];
  assert.equal(referenceNotes({ row: unknownCat, productIdCell: "" }), "NEW PRODUCT / CATEGORY REVIEW");
  const aoa = buildMalikasReferenceAoa(itemsOf([product("p2", "mk176", { category: "Uncategorized" })]));
  assert.equal(aoa[1][REFERENCE_COL.rafeeqCategory], "", "unmapped category shows blank RAFEEQ CATEGORY");
  assert.ok(String(aoa[1][REFERENCE_COL.notes]).includes("CATEGORY REVIEW"));
});
