// RAFEEQ NATIVE-OPTION model tests — the audited real Rafeeq workbook contract.
// Owner regression scenarios: exact 40-header template; one product identity per
// canonical product; options as repeated rows of ONE parent (never separate
// products); parent title/price/barcode/image repeated unchanged; option labels
// only in option cells; audited group defaults; deterministic ordering;
// identity arithmetic (62 option parents stay 62 products, 197 variants become
// 197 options).
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/native-options.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { buildRafeeqPreview, type RafeeqPreviewProduct, type RafeeqPreviewVariant } from "./preview.ts";
import { toPackageRow, buildRafeeqXlsxAoa, physicalRowCount, planRowImages, primaryFilenameFor } from "./package.ts";
import {
  RAFEEQ_NATIVE_HEADERS,
  RAFEEQ_NATIVE_SHEET,
  RAFEEQ_GROUP_DEFAULTS,
  RAFEEQ_PRODUCT_DEFAULTS,
  NATIVE_COL,
} from "./native-template.ts";

let ean = 6291041500300;
function variant(id: string, sku: string, over: Partial<RafeeqPreviewVariant> = {}): RafeeqPreviewVariant {
  ean += 1;
  return { id, sku, barcode: String(ean), nameEn: `Option ${id}`, nameAr: `خيار ${id}`, price: null, ...over };
}
function product(id: string, sku: string, over: Partial<RafeeqPreviewProduct> = {}): RafeeqPreviewProduct {
  ean += 1;
  return {
    id, sku, barcode: String(ean),
    nameEn: `Parent ${sku}`, nameAr: `الأصل ${sku}`,
    category: "Makeup", price: 100, discountPrice: null,
    descriptionEn: "Parent EN description.", descriptionAr: "وصف الأصل.",
    imageUrl: `https://cdn.example.com/${sku}.jpg`, imageFilename: `${sku}.jpg`,
    galleryImageUrls: [], imageCount: 1,
    lifecycleState: "ACTIVE", platformStatus: "Active",
    ...over,
  };
}
const rowsOf = (products: RafeeqPreviewProduct[]) => buildRafeeqPreview({ products }).rows;
const aoaOf = (products: RafeeqPreviewProduct[]) => {
  const rows = buildRafeeqPreview({ products }).rows;
  return buildRafeeqXlsxAoa(rows.map((r) => toPackageRow(r, primaryFilenameFor(r.sku, "jpg"))));
};

// ── 1) exact 40 headers, exact order, audited sheet name ──────────────────────
test("1: the template is EXACTLY the audited 40 headers in the audited order", () => {
  assert.equal(RAFEEQ_NATIVE_HEADERS.length, 40);
  assert.deepEqual([...RAFEEQ_NATIVE_HEADERS], [
    "category_id", "category_name_english", "category_name_arabic", "category_status",
    "subcategory_id", "subcategory_name_english", "subcategory_name_arabic", "subcategory_status",
    "subsubcategory_id", "subsubcategory_name_english", "subsubcategory_name_arabic", "subsubcategory_status",
    "product_id", "product_name_english", "product_name_arabic",
    "product_description_english", "product_description_arabic",
    "product_status", "product_availability", "active",
    "product_price", "barcode", "pos_id", "product_preparation_time", "product_image",
    "groups", "group_id", "group_name_english", "group_name_arabic",
    "max_selection", "min_selection", "free_selection", "group_status", "group_sort_order", "group_design_type",
    "option_id", "option_name_english", "option_name_arabic", "option_price", "option_sort_order",
  ]);
  assert.equal(RAFEEQ_NATIVE_SHEET, "data");
  assert.deepEqual(aoaOf([product("p1", "mk1")])[0], [...RAFEEQ_NATIVE_HEADERS], "AoA header row is the audited template");
});

// ── 2) simple product ⇒ ONE row, groups = 0, blank option cells ───────────────
test("2: a simple product outputs exactly ONE physical row with groups=0 and blank group/option cells", () => {
  const aoa = aoaOf([product("p1", "mk1")]);
  assert.equal(aoa.length, 2, "header + one physical row");
  const row = aoa[1];
  assert.equal(row[NATIVE_COL.groups], 0);
  for (const c of [NATIVE_COL.groupId, NATIVE_COL.groupNameEn, NATIVE_COL.groupNameAr, NATIVE_COL.maxSelection,
                   NATIVE_COL.minSelection, NATIVE_COL.freeSelection, NATIVE_COL.groupStatus, NATIVE_COL.groupSortOrder,
                   NATIVE_COL.groupDesignType, NATIVE_COL.optionId, NATIVE_COL.optionNameEn, NATIVE_COL.optionNameAr,
                   NATIVE_COL.optionPrice, NATIVE_COL.optionSortOrder]) {
    assert.equal(row[c], "", `simple row column ${c} stays blank`);
  }
});

// ── 3) 2-option product ⇒ TWO repeated rows, SAME parent identity ─────────────
test("3: a 2-option product outputs two repeated rows sharing the SAME parent identity — one Rafeeq product", () => {
  const res = buildRafeeqPreview({ products: [product("p1", "mk10", { variants: [variant("v1", "mk10-1"), variant("v2", "mk10-2")] })] });
  assert.equal(res.rows.length, 1, "ONE product-grain preview row");
  assert.equal(res.counts.productCount, 1, "ONE Rafeeq product identity");
  assert.equal(res.counts.optionCount, 2);
  assert.equal(res.counts.physicalRowCount, 2);
  const aoa = aoaOf([product("p1", "mk10", { variants: [variant("v1", "mk10-1"), variant("v2", "mk10-2")] })]);
  assert.equal(aoa.length, 3, "header + two repeated physical rows");
  const [a, b] = [aoa[1], aoa[2]];
  // every parent cell identical across the repeated rows (through `groups`)
  for (let c = 0; c <= NATIVE_COL.groups; c++) assert.deepEqual(a[c], b[c], `parent cell ${c} repeats identically`);
  // only option cells vary
  assert.notEqual(a[NATIVE_COL.optionNameEn], b[NATIVE_COL.optionNameEn]);
  assert.notEqual(a[NATIVE_COL.optionSortOrder], b[NATIVE_COL.optionSortOrder]);
});

// ── 4) parent title repeats UNCHANGED (never "{parent} — {option}") ───────────
test("4: option rows repeat the PARENT title unchanged — no flattened '{parent} — {option}' names", () => {
  const aoa = aoaOf([product("p1", "mk10", { variants: [variant("v1", "mk10-1", { nameEn: "Rose Gold", nameAr: "ذهبي وردي" })] })]);
  const row = aoa[1];
  assert.equal(row[NATIVE_COL.productNameEn], "Parent mk10");
  assert.equal(row[NATIVE_COL.productNameAr], "الأصل mk10");
  assert.ok(!String(row[NATIVE_COL.productNameEn]).includes("—"), "no em-dash flattening in the product name");
  assert.ok(!String(row[NATIVE_COL.productNameEn]).includes("Rose Gold"), "the option label never leaks into the product name");
});

// ── 5) barcode = parent SKU repeated across option rows ───────────────────────
test("5: the barcode cell carries the parent SKU, repeated identically on every option row", () => {
  const aoa = aoaOf([product("p1", "mk175", { variants: [variant("v1", "mk175-1"), variant("v2", "mk175-2"), variant("v3", "mk175-3")] })]);
  assert.equal(aoa.length, 4);
  for (const row of aoa.slice(1)) assert.equal(row[NATIVE_COL.barcode], "mk175");
});

// ── 6 + 7) real EAN / variant sku / variant barcode never exported ────────────
test("6/7: the real EAN and the variant sku/barcode never reach ANY exported cell", () => {
  const parent = product("p1", "mk175", { barcode: "6291041509999", variants: [
    variant("v1", "mk175-1-red", { barcode: "6291041508888" }),
    variant("v2", "mk175-2-blue", { barcode: "6291041508889" }),
  ] });
  const aoa = aoaOf([parent]);
  const allCells = aoa.slice(1).flatMap((r) => r.map((c) => String(c)));
  for (const leaked of ["6291041509999", "6291041508888", "6291041508889", "mk175-1-red", "mk175-2-blue"]) {
    for (const cell of allCells) assert.ok(!cell.includes(leaked), `"${leaked}" leaked into cell "${cell}"`);
  }
});

// ── 8) option labels ONLY in option cells ─────────────────────────────────────
test("8: option names populate ONLY the option name cells", () => {
  const aoa = aoaOf([product("p1", "mk10", { variants: [variant("v1", "mk10-1", { nameEn: "Raspberry Jelly", nameAr: "جيلي التوت" })] })]);
  const row = aoa[1];
  assert.equal(row[NATIVE_COL.optionNameEn], "Raspberry Jelly");
  assert.equal(row[NATIVE_COL.optionNameAr], "جيلي التوت");
  for (let c = 0; c < row.length; c++) {
    if (c === NATIVE_COL.optionNameEn || c === NATIVE_COL.optionNameAr) continue;
    assert.ok(!String(row[c]).includes("Raspberry Jelly"), `option label leaked into column ${c}`);
  }
});

// ── 9 + 10) ONE parent image shared by option rows, parent-SKU filename ───────
test("9/10: one parent-SKU image serves every option row — no variant-SKU image identity, no per-option duplication", () => {
  const p = product("p1", "mk10", { variants: [variant("v1", "mk10-1"), variant("v2", "mk10-2")] });
  const res = buildRafeeqPreview({ products: [p] });
  const r = res.rows[0];
  assert.equal(r.imageExportName, "mk10.jpg", "parent-SKU filename");
  const plan = planRowImages(r);
  assert.equal(plan.primary?.filename, "mk10.jpg");
  const aoa = aoaOf([p]);
  for (const row of aoa.slice(1)) assert.equal(row[NATIVE_COL.productImage], "mk10.jpg", "same file referenced by every option row");
  // ONE image plan per PRODUCT — never one per option
  assert.equal(res.rows.length, 1, "one product ⇒ one image plan");
  for (const row of aoa.slice(1)) assert.ok(!String(row[NATIVE_COL.productImage]).includes("mk10-1"), "no variant-SKU image name");
});

// ── 11 + 12) groups=1 + audited group/product defaults on option rows ─────────
test("11/12: option rows carry groups=1 and the audited selection/group + product defaults", () => {
  const aoa = aoaOf([product("p1", "mk10", { variants: [variant("v1", "mk10-1")] })]);
  const row = aoa[1];
  assert.equal(row[NATIVE_COL.groups], 1);
  assert.equal(row[NATIVE_COL.maxSelection], RAFEEQ_GROUP_DEFAULTS.maxSelection);
  assert.equal(row[NATIVE_COL.minSelection], RAFEEQ_GROUP_DEFAULTS.minSelection);
  assert.equal(row[NATIVE_COL.freeSelection], RAFEEQ_GROUP_DEFAULTS.freeSelection);
  assert.equal(row[NATIVE_COL.groupStatus], RAFEEQ_GROUP_DEFAULTS.groupStatus);
  assert.equal(row[NATIVE_COL.groupSortOrder], RAFEEQ_GROUP_DEFAULTS.groupSortOrder);
  assert.equal(row[NATIVE_COL.groupDesignType], RAFEEQ_GROUP_DEFAULTS.groupDesignType);
  assert.equal(row[NATIVE_COL.productStatus], RAFEEQ_PRODUCT_DEFAULTS.productStatus);
  assert.equal(row[NATIVE_COL.productAvailability], RAFEEQ_PRODUCT_DEFAULTS.productAvailability);
  assert.equal(row[NATIVE_COL.active], RAFEEQ_PRODUCT_DEFAULTS.active);
  assert.equal(row[NATIVE_COL.preparationTime], RAFEEQ_PRODUCT_DEFAULTS.preparationTime);
  assert.equal(row[NATIVE_COL.posId], "", "pos_id stays blank (audited)");
  // default group names (no reliable canonical option axis exists)
  assert.equal(row[NATIVE_COL.groupNameEn], "Options");
  assert.equal(row[NATIVE_COL.groupNameAr], "الخيارات");
  // ids are NEVER invented for new records
  assert.equal(row[NATIVE_COL.productId], "");
  assert.equal(row[NATIVE_COL.groupId], "");
  assert.equal(row[NATIVE_COL.optionId], "");
});

// ── 13) deterministic option ordering ─────────────────────────────────────────
test("13: option ordering is deterministic (internal sku natural order) regardless of input order", () => {
  const shuffled = product("p1", "mk10", { variants: [variant("v3", "mk10-3"), variant("v1", "mk10-1"), variant("v10", "mk10-10"), variant("v2", "mk10-2")] });
  const r = buildRafeeqPreview({ products: [shuffled] }).rows[0];
  assert.deepEqual(r.options.map((o) => o.internalSku), ["mk10-1", "mk10-2", "mk10-3", "mk10-10"], "natural numeric order");
  assert.deepEqual(r.options.map((o) => o.sortOrder), [1, 2, 3, 4]);
  const aoa = aoaOf([shuffled]);
  assert.deepEqual(aoa.slice(1).map((row) => row[NATIVE_COL.optionSortOrder]), [1, 2, 3, 4]);
});

// ── 14 + 15 + 16) identity arithmetic — production shape ──────────────────────
test("14/15/16: N canonical products stay N identities; variants project as options, never independent products", () => {
  const products: RafeeqPreviewProduct[] = [];
  for (let i = 0; i < 8; i++) products.push(product(`s${i}`, `mk-s${i}`));
  products.push(product("m1", "mk-m1", { variants: [variant("m1v1", "mk-m1-1"), variant("m1v2", "mk-m1-2"), variant("m1v3", "mk-m1-3")] }));
  products.push(product("m2", "mk-m2", { variants: [variant("m2v1", "mk-m2-1"), variant("m2v2", "mk-m2-2")] }));
  const res = buildRafeeqPreview({ products });
  assert.equal(res.counts.productCount, 10, "10 canonical products = 10 Rafeeq identities");
  assert.equal(res.counts.productsWithOptions, 2);
  assert.equal(res.counts.optionCount, 5, "5 variants = 5 options");
  assert.equal(res.counts.physicalRowCount, 8 + 5, "simple rows + one row per option");
  assert.equal(res.rows.length, 10, "one preview row per product — no independent variant row exists");
  // no preview row carries a variant sku as its own product identity
  const skus = new Set(res.rows.map((r) => r.sku));
  for (const vsku of ["mk-m1-1", "mk-m1-2", "mk-m1-3", "mk-m2-1", "mk-m2-2"]) {
    assert.equal(skus.has(vsku), false, `variant ${vsku} must not be a product identity`);
  }
  const rows = res.rows.map((r) => toPackageRow(r, primaryFilenameFor(r.sku, "jpg")));
  assert.equal(physicalRowCount(rows), 13);
});

// ── pricing: uniform option price becomes the product price ───────────────────
test("a uniform effective option price becomes product_price with option_price 0; differing prices block (unresolved contract)", () => {
  // uniform: variants explicitly at 110 while the stale parent price says 33
  const uniform = buildRafeeqPreview({ products: [product("p1", "mk1158", { price: 33, variants: [
    variant("v1", "mk1158-1", { price: 110 }), variant("v2", "mk1158-2", { price: 110 }),
  ] })] }).rows[0];
  assert.equal(uniform.price, 110, "uniform option price wins over the stale parent price");
  assert.equal(uniform.optionPriceUnresolved, false);
  assert.ok(uniform.status !== "BLOCKED");
  const aoa = buildRafeeqXlsxAoa([toPackageRow(uniform, "mk1158.jpg")]);
  assert.equal(aoa[1][NATIVE_COL.productPrice], "110", "product_price emitted as TEXT (audited)");
  assert.deepEqual(aoa.slice(1).map((r) => r[NATIVE_COL.optionPrice]), [0, 0]);

  // differing: encoding unproven by the workbook ⇒ blocked, surfaced
  const differing = buildRafeeqPreview({ products: [product("p2", "mk995", { variants: [
    variant("w1", "mk995-1", { price: 158 }), variant("w2", "mk995-2", { price: 178 }),
  ] })] }).rows[0];
  assert.equal(differing.optionPriceUnresolved, true);
  assert.equal(differing.status, "BLOCKED");
  assert.ok(differing.reasons.some((x) => x.code === "OPTION_PRICE_UNRESOLVED" && x.blocking));
});

// ── unknown category ⇒ blank category cells + warning (no invented ids) ───────
test("an unknown canonical category emits blank category cells and warns — a Rafeeq category id is never invented", () => {
  const r = rowsOf([product("p1", "mk1", { category: "Perfumes" })])[0];
  assert.ok(r.reasons.some((x) => x.code === "MISSING_CATEGORY" && !x.blocking), "unknown category is disclosed as a warning");
  const aoa = aoaOf([product("p1", "mk1", { category: "Perfumes" })]);
  assert.equal(aoa[1][NATIVE_COL.categoryId], "", "no invented category id");
  assert.equal(aoa[1][NATIVE_COL.categoryNameEn], "");
  const known = aoaOf([product("p2", "mk2", { category: "Makeup" })]);
  assert.equal(known[1][NATIVE_COL.categoryId], 3708643);
  assert.equal(known[1][NATIVE_COL.categoryNameAr], "المكياج");
  assert.equal(known[1][NATIVE_COL.subcategoryId], 260178, "the category's audited ALL subcategory");
});

// ── STOPPED parent blocks the whole product (options included) ────────────────
test("a STOPPED parent lifecycle blocks the product (its options never export separately)", () => {
  const rows = rowsOf([product("p1", "mk10", { lifecycleState: "STOPPED", variants: [variant("v1", "mk10-1")] })]);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].status === "BLOCKED" && rows[0].reasons.some((x) => x.code === "LIFECYCLE_NOT_ELIGIBLE"));
});
