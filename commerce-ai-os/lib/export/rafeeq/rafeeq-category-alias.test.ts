// OWNER-APPROVED Rafeeq category alias — "Summer And Camping Supplies" maps to
// the existing audited live category "Summer Essentials" (id 3708645, sub ALL
// 260180). Export-layer only: the canonical catalog name is never renamed.
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/rafeeq-category-alias.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  NATIVE_COL,
  RAFEEQ_CATEGORY_ALIASES,
  RAFEEQ_NATIVE_CATEGORIES,
  rafeeqCategoryByName,
  rafeeqCategoryKeyByName,
} from "./native-template.ts";
import { buildRafeeqPreview, type RafeeqPreviewProduct } from "./preview.ts";
import { toPackageRow, buildRafeeqXlsxAoa } from "./package.ts";
import { buildMalikasReferenceAoa, mappedRafeeqCategoryName, REFERENCE_COL } from "./reference.ts";

const SUMMER = "Summer And Camping Supplies";

function product(id: string, sku: string, over: Partial<RafeeqPreviewProduct> = {}): RafeeqPreviewProduct {
  return {
    id, sku, barcode: "6291041500213",
    nameEn: `Product ${sku}`, nameAr: `منتج ${sku}`,
    category: SUMMER, price: 100, discountPrice: null,
    descriptionEn: "en", descriptionAr: "ar",
    imageUrl: `https://cdn.example.com/${sku}.jpg`, imageFilename: `${sku}.jpg`,
    galleryImageUrls: [], imageCount: 1,
    lifecycleState: "ACTIVE", platformStatus: "Active",
    ...over,
  };
}

test("1+2: Summer And Camping Supplies resolves to category_id 3708645 and subcategory_id 260180", () => {
  const cat = rafeeqCategoryByName(SUMMER);
  assert.ok(cat, "alias resolves");
  assert.equal(cat.id, 3708645);
  assert.equal(cat.sub?.id, 260180);
  assert.equal(cat.sub?.en, "ALL");
  assert.equal(cat.status, 1);
  assert.equal(rafeeqCategoryKeyByName(SUMMER), "Summer Essentials");
});

test("3: the exported category cells carry the LIVE name Summer Essentials (EN + AR), never the canonical name", () => {
  const row = buildRafeeqPreview({ products: [product("p1", "mk869")] }).rows[0];
  const aoa = buildRafeeqXlsxAoa([toPackageRow(row, "mk869.jpg")]);
  const cells = aoa[1];
  assert.equal(cells[NATIVE_COL.categoryId], 3708645);
  assert.equal(cells[NATIVE_COL.categoryNameEn], "Summer Essentials");
  assert.equal(cells[NATIVE_COL.categoryNameAr], "مستلزمات الصيف");
  assert.equal(cells[NATIVE_COL.categoryStatus], 1);
  assert.equal(cells[NATIVE_COL.subcategoryId], 260180);
  assert.equal(cells[NATIVE_COL.subcategoryNameEn], "ALL");
  for (const c of aoa.flat()) assert.notEqual(c, SUMMER, "canonical name never appears in a data cell");
  // the Malikas Reference sheet shows the live name too (canonical stays in CATEGORY)
  const ref = buildMalikasReferenceAoa([{ row, imageFilename: "mk869.jpg", productIdCell: "" }]);
  assert.equal(ref[1][REFERENCE_COL.category], SUMMER, "CATEGORY column keeps the canonical name");
  assert.equal(ref[1][REFERENCE_COL.rafeeqCategory], "Summer Essentials");
  assert.equal(mappedRafeeqCategoryName(SUMMER), "Summer Essentials");
});

test("4: every existing exact category mapping is unchanged (each registry key resolves to itself)", () => {
  for (const [key, entry] of Object.entries(RAFEEQ_NATIVE_CATEGORIES)) {
    assert.equal(rafeeqCategoryKeyByName(key), key, `exact key ${key} resolves to itself`);
    assert.equal(rafeeqCategoryByName(key)?.id, entry.id);
  }
  // audited spot checks incl. the U+2019 apostrophe fold
  assert.equal(rafeeqCategoryByName("Makeup")?.id, 3708643);
  assert.equal(rafeeqCategoryByName("Makeup")?.sub?.id, 260178);
  assert.equal(rafeeqCategoryByName("Women’s Essentials")?.id, 4415761);
  assert.equal(rafeeqCategoryKeyByName("Women’s Essentials"), "Women's Essentials");
});

test("5+8: unknown categories (e.g. the remaining Uncategorized products) still emit blank ids + MISSING_CATEGORY warning", () => {
  const preview = buildRafeeqPreview({ products: [product("p1", "mk1016", { category: "Uncategorized" })] });
  const r = preview.rows[0];
  assert.ok(r.reasons.some((x) => x.code === "MISSING_CATEGORY" && !x.blocking), "Uncategorized still warns");
  const aoa = buildRafeeqXlsxAoa([toPackageRow(r, "mk1016.jpg")]);
  assert.equal(aoa[1][NATIVE_COL.categoryId], "");
  assert.equal(aoa[1][NATIVE_COL.categoryNameEn], "");
  assert.equal(aoa[1][NATIVE_COL.subcategoryId], "");
  assert.equal(mappedRafeeqCategoryName("Uncategorized"), null);
});

test("6: no fuzzy matching — only the exact alias key resolves", () => {
  for (const near of [
    "Summer & Camping Supplies",
    "summer and camping supplies",
    "SUMMER AND CAMPING SUPPLIES",
    "Summer and Camping Supplies",
    "Summer And Camping Supply",
    "Summer Camping Supplies",
    "Summer Essential",
    "Camping Supplies",
  ]) {
    assert.equal(rafeeqCategoryKeyByName(near), undefined, `near-miss ${JSON.stringify(near)} must NOT resolve`);
    assert.equal(rafeeqCategoryByName(near), undefined);
  }
  // the alias table is exactly the one approved entry
  assert.deepEqual(RAFEEQ_CATEGORY_ALIASES, { [SUMMER]: "Summer Essentials" });
});

test("7: all 23 current Summer And Camping Supplies products export WITHOUT MISSING_CATEGORY", () => {
  const SKUS = [
    "mk1578", "mk1579", "mk1823", "mk1830", "mk1834", "mk1885", "mk1887", "mk1997",
    "mk2204", "mk2261", "mk2272", "mk2276", "mk869", "mk870", "mk871", "mk873",
    "mk875", "mk876", "mk877", "mk890", "mk894", "mk910", "mk911",
  ];
  assert.equal(SKUS.length, 23);
  const preview = buildRafeeqPreview({ products: SKUS.map((s, i) => product(`p${i}`, s)) });
  assert.equal(preview.rows.length, 23);
  for (const r of preview.rows) {
    assert.ok(!r.reasons.some((x) => x.code === "MISSING_CATEGORY"), `${r.sku} must not warn MISSING_CATEGORY`);
  }
  const aoa = buildRafeeqXlsxAoa(preview.rows.map((r) => toPackageRow(r, `${r.sku}.jpg`)));
  assert.equal(aoa.length, 24, "header + 23 physical rows");
  for (const cells of aoa.slice(1)) {
    assert.equal(cells[NATIVE_COL.categoryId], 3708645);
    assert.equal(cells[NATIVE_COL.categoryNameEn], "Summer Essentials");
    assert.equal(cells[NATIVE_COL.subcategoryId], 260180);
  }
});
