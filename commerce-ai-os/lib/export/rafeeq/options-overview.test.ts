// OPTIONS OVERVIEW — third-sheet tests (FINAL OPTIONS CLARITY UPDATE).
// Proves the owner's 12 requirements at unit grain: the workbook carries
// exactly three sheets with the data contract untouched; the overview holds
// ONLY option parents as visual blocks with correct numbering, totals,
// price-type lines and canonical option names/prices; and no option is ever
// presented as an independent Rafeeq product. (In production the same
// invariants make the sheet show the expected 62 parents / 197 options —
// the counts come from the preview, which the engine already certifies.)
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/options-overview.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildRafeeqPreview, type RafeeqPreviewProduct, type RafeeqPreviewVariant } from "./preview.ts";
import { toPackageRow } from "./package.ts";
import { buildMalikasReferenceAoa } from "./reference.ts";
import { buildOptionsOverviewSheet, optionsPriceTypeText, OPTIONS_OVERVIEW_SHEET } from "./options-overview.ts";
import { buildRafeeqXlsxBuffer } from "../../rafeeq/package-xlsx.ts";
import { RAFEEQ_NATIVE_SHEET, RAFEEQ_NATIVE_HEADERS } from "./native-template.ts";
import { MALIKAS_REFERENCE_SHEET } from "./reference.ts";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

function variant(id: string, sku: string, over: Partial<RafeeqPreviewVariant> = {}): RafeeqPreviewVariant {
  return { id, sku, barcode: "6291041500301", nameEn: `Option ${id}`, nameAr: `خيار ${id}`, price: null, ...over };
}
function product(id: string, sku: string, over: Partial<RafeeqPreviewProduct> = {}): RafeeqPreviewProduct {
  return {
    id, sku, barcode: "6291041500213",
    nameEn: `Product ${sku}`, nameAr: `منتج ${sku}`,
    category: "Makeup", price: 100, discountPrice: null,
    descriptionEn: "en", descriptionAr: "ar",
    imageUrl: `https://cdn.example.com/${sku}.jpg`, imageFilename: `${sku}.jpg`,
    galleryImageUrls: [], imageCount: 1,
    lifecycleState: "ACTIVE", platformStatus: "Active",
    ...over,
  };
}

// mixed fixture: 2 simple products, 1 uniform-price option parent (2 options),
// 1 differing-price option parent (3 options, decimals included).
function fixture() {
  const products = [
    product("p1", "mk1"),
    product("p2", "mk2", { variants: [
      variant("v1", "mk2-1-gray", { nameEn: "Unscented - Gray", nameAr: "رمادي" }),
      variant("v2", "mk2-2-jelly", { nameEn: "Raspberry Jelly", nameAr: "توت" }),
    ] }),
    product("p3", "mk3"),
    product("p4", "mk4", { variants: [
      variant("v3", "mk4-1-a", { nameEn: "Small", price: 65 }),
      variant("v4", "mk4-2-b", { nameEn: "Medium", price: 69.5 }),
      variant("v5", "mk4-3-c", { nameEn: "Large", price: 78 }),
    ] }),
  ];
  const preview = buildRafeeqPreview({ products });
  const items = preview.rows.map((r) => ({ row: r, imageFilename: `${r.sku}.jpg` }));
  return { preview, items };
}

test("1+2: the workbook carries exactly the three sheets and the data sheet keeps the exact 40-column schema", () => {
  const { preview, items } = fixture();
  const referenceAoa = buildMalikasReferenceAoa(items.map((it) => ({ ...it, productIdCell: "" })));
  const overview = buildOptionsOverviewSheet(items);
  const wb = XLSX.read(buildRafeeqXlsxBuffer(preview.rows.map((r) => toPackageRow(r, `${r.sku}.jpg`)), referenceAoa, overview), { type: "buffer" });
  assert.deepEqual(wb.SheetNames, [RAFEEQ_NATIVE_SHEET, MALIKAS_REFERENCE_SHEET, OPTIONS_OVERVIEW_SHEET], "exactly three sheets, data first");
  const header = XLSX.utils.sheet_to_json(wb.Sheets[RAFEEQ_NATIVE_SHEET], { header: 1 })[0];
  assert.deepEqual(header, [...RAFEEQ_NATIVE_HEADERS], "audited 40-column import schema unchanged");
});

test("3+4+5: the overview holds ONLY option parents — one block each — and every option row; simple products never appear", () => {
  const { items } = fixture();
  const ov = buildOptionsOverviewSheet(items);
  assert.equal(ov.productCount, 2, "one block per option parent");
  assert.equal(ov.optionCount, 5, "2 + 3 option rows");
  const flat = ov.aoa.flat().map(String);
  const blockHeaders = flat.filter((c) => c.startsWith("PRODUCT: "));
  assert.deepEqual(blockHeaders, ["PRODUCT: mk2", "PRODUCT: mk4"]);
  assert.ok(!flat.some((c) => c.includes("mk1")), "simple product mk1 absent");
  assert.ok(!flat.some((c) => c.includes("mk3")), "simple product mk3 absent");
  const optionRows = ov.rowKinds.filter((k) => k === "option" || k === "optionAlt").length;
  assert.equal(optionRows, 5, "exactly the option rows, nothing more");
  assert.equal(ov.rowKinds.length, ov.aoa.length, "every row carries a style kind");
});

test("6+7+8: options sit inside exactly one parent block with correct ROW TYPE numbering and matching TOTAL OPTIONS", () => {
  const { items } = fixture();
  const ov = buildOptionsOverviewSheet(items);
  // walk blocks: header → meta(TOTAL OPTIONS) → table → options
  let current: { sku: string; total: number; seen: number } | null = null;
  ov.aoa.forEach((row, i) => {
    const kind = ov.rowKinds[i];
    if (kind === "blockHeader") {
      if (current) assert.equal(current.seen, current.total, `block ${current.sku} option count matches TOTAL OPTIONS`);
      current = { sku: String(row[0]).replace("PRODUCT: ", ""), total: 0, seen: 0 };
    }
    if (kind === "blockMeta" && row[0] === "TOTAL OPTIONS" && current) current.total = Number(row[1]);
    if ((kind === "option" || kind === "optionAlt") && current) {
      current.seen += 1;
      assert.equal(row[0], current.seen, "sequential # numbering");
      assert.equal(row[4], `OPTION ${current.seen} OF ${current.total}`, "ROW TYPE numbering is correct");
    }
  });
  assert.ok(current, "walked at least one block");
  assert.equal(current!.seen, current!.total);
});

test("9+10: differing prices show PRICE ON SELECTION (with Arabic) per option; uniform products show the uniform price", () => {
  const { items } = fixture();
  const ov = buildOptionsOverviewSheet(items);
  const uniformRow = items.find((it) => it.row.sku === "mk2")!.row;
  const posRow = items.find((it) => it.row.sku === "mk4")!.row;
  assert.equal(optionsPriceTypeText(uniformRow), "UNIFORM PRICE 100 QAR / سعر موحّد 100 ر.ق");
  assert.equal(optionsPriceTypeText(posRow), "PRICE ON SELECTION / السعر حسب الخيار");
  // per-option price cells: uniform → the uniform price repeated; differing → each FULL price
  const prices = ov.aoa.filter((_, i) => ov.rowKinds[i] === "option" || ov.rowKinds[i] === "optionAlt").map((r) => r[3]);
  assert.deepEqual(prices, [100, 100, 65, 69.5, 78], "full canonical prices, decimals preserved — never deltas");
});

test("11+12: option names match the canonical variants and NO variant is presented as an independent product", () => {
  const { items } = fixture();
  const ov = buildOptionsOverviewSheet(items);
  const flat = ov.aoa.flat().map(String);
  for (const name of ["Unscented - Gray", "Raspberry Jelly", "Small", "Medium", "Large"]) {
    assert.ok(flat.includes(name), `canonical option name shown: ${name}`);
  }
  for (const vsku of ["mk2-1-gray", "mk2-2-jelly", "mk4-1-a", "mk4-2-b", "mk4-3-c"]) {
    assert.ok(!flat.some((c) => c.includes(vsku)), `variant SKU stays internal: ${vsku}`);
  }
  assert.ok(!flat.some((c) => c.startsWith("PRODUCT: mk2-") || c.startsWith("PRODUCT: mk4-")), "no option ever appears as its own product block");
  // the semantics statements are present
  assert.ok(flat.some((c) => c.includes("NOT independent products")), "semantics: options are not independent products");
  assert.ok(flat.some((c) => c.includes("identify the CHOICE")), "semantics: parent identifies product, option identifies choice");
  assert.ok(flat.some((c) => c.includes("ONE PRODUCT / منتج واحد")), "per-block ONE PRODUCT marker");
});
