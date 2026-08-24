// RAFEEQ TEMPLATE BARCODE RULE (owner decision, 2026-08-24) — the Rafeeq
// BARCODE column carries the canonical PARENT product SKU for every row:
//   1. simple product  → Rafeeq barcode = the product's own (parent) SKU
//   2. product with options → EVERY repeated option row carries the SAME
//      parent SKU in the barcode column (Rafeeq's grouping key — options are
//      one product with option fields, never separate products)
//   3. the real EAN/product barcode is NEVER written to the Rafeeq barcode
//   4. a variant SKU is NEVER written to the Rafeeq barcode
//   5. a variant barcode is NEVER exported to Rafeeq at all
// Canonical internal sku/barcode data is untouched — export projection only.
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/rafeeq-barcode-rule.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { buildRafeeqPreview, type RafeeqPreviewProduct, type RafeeqPreviewVariant } from "./preview.ts";
import { toPackageRow, buildRafeeqXlsxAoa, planRowImages, primaryFilenameFor } from "./package.ts";

const PARENT_EAN = "6291041500213";
const VARIANT_EANS = ["6291041500301", "6291041500302", "6291041500303"] as const;

function variant(id: string, sku: string, ean: string, over: Partial<RafeeqPreviewVariant> = {}): RafeeqPreviewVariant {
  return { id, sku, barcode: ean, nameEn: `Option ${id}`, nameAr: `خيار ${id}`, price: null, ...over };
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
/** All spreadsheet cells of the exported AoA (excluding the header row). */
function exportedCells(products: RafeeqPreviewProduct[]): { barcodes: string[]; all: string[] } {
  const rows = buildRafeeqPreview({ products }).rows;
  const aoa = buildRafeeqXlsxAoa(rows.map((r) => toPackageRow(r, primaryFilenameFor(r.sku, "jpg"))));
  const data = aoa.slice(1);
  return { barcodes: data.map((r) => String(r[8])), all: data.flatMap((r) => r.map((c) => String(c))) };
}

// ── 1) simple product: Rafeeq barcode = parent SKU ────────────────────────────
test("1: a simple product exports its own (parent) SKU in the Rafeeq barcode column", () => {
  const res = buildRafeeqPreview({ products: [product("p1", "mk175")] });
  assert.equal(res.rows[0].barcode, "mk175");
  const { barcodes } = exportedCells([product("p1", "mk175")]);
  assert.deepEqual(barcodes, ["mk175"]);
});

// ── 2) options: every repeated option row carries the SAME parent SKU ─────────
test("2: every option row of a product repeats the SAME parent SKU in the barcode column", () => {
  const p = product("p1", "mk175", {
    variants: [
      variant("v1", "mk175-1-red", VARIANT_EANS[0]),
      variant("v2", "mk175-2-blue", VARIANT_EANS[1]),
      variant("v3", "mk175-3-gold", VARIANT_EANS[2]),
    ],
  });
  const res = buildRafeeqPreview({ products: [p] });
  assert.equal(res.rows.length, 3, "one row per option, no parent row");
  assert.ok(res.rows.every((r) => r.barcode === "mk175"), "all option rows share the parent SKU barcode");
  const { barcodes } = exportedCells([p]);
  assert.deepEqual(barcodes, ["mk175", "mk175", "mk175"]);
  // the deliberate repetition is BY DESIGN — never a duplicate-barcode block
  assert.ok(res.rows.every((r) => !r.reasons.some((x) => x.code === "DUPLICATE_BARCODE")));
  assert.ok(res.rows.every((r) => r.status !== "BLOCKED"));
});

// ── 3) the real EAN is never written to the Rafeeq barcode ────────────────────
test("3: the real EAN/product barcode never reaches the Rafeeq barcode column", () => {
  const simple = product("p1", "mk175"); // carries PARENT_EAN internally
  const withOptions = product("p2", "mk200", { variants: [variant("v1", "mk200-1", VARIANT_EANS[0])] });
  const { barcodes } = exportedCells([simple, withOptions]);
  for (const b of barcodes) {
    assert.notEqual(b, PARENT_EAN, "parent EAN never exported as barcode");
    for (const ean of VARIANT_EANS) assert.notEqual(b, ean, "variant EAN never exported as barcode");
  }
  assert.deepEqual(barcodes, ["mk175", "mk200"]);
});

// ── 4) a variant SKU is never written to the Rafeeq barcode ───────────────────
test("4: a variant SKU never reaches the Rafeeq barcode column", () => {
  const p = product("p1", "mk175", {
    variants: [variant("v1", "mk175-1-red", VARIANT_EANS[0]), variant("v2", "mk175-2-blue", VARIANT_EANS[1])],
  });
  const res = buildRafeeqPreview({ products: [p] });
  const variantSkus = new Set(["mk175-1-red", "mk175-2-blue"]);
  for (const r of res.rows) {
    assert.ok(!variantSkus.has(r.barcode ?? ""), "barcode is never the variant's own SKU");
    assert.equal(r.barcode, "mk175");
  }
  const { barcodes } = exportedCells([p]);
  for (const b of barcodes) assert.ok(!variantSkus.has(b));
});

// ── 5) a variant barcode is never exported to Rafeeq at all ───────────────────
test("5: variant barcodes never appear ANYWHERE in the exported spreadsheet or image plan", () => {
  const p = product("p1", "mk175", {
    variants: [
      variant("v1", "mk175-1-red", VARIANT_EANS[0]),
      variant("v2", "mk175-2-blue", VARIANT_EANS[1]),
      variant("v3", "mk175-3-gold", VARIANT_EANS[2]),
    ],
  });
  const { all } = exportedCells([p]);
  for (const cell of all) {
    for (const ean of VARIANT_EANS) assert.ok(!cell.includes(ean), `variant barcode ${ean} leaked into cell "${cell}"`);
  }
  // the image plan (packaged filenames) is SKU-based — no EAN there either
  const rows = buildRafeeqPreview({ products: [p] }).rows;
  for (const r of rows) {
    const plan = planRowImages(r);
    const names = [plan.primary?.filename ?? "", ...plan.gallery.map((g) => g.filename)];
    for (const n of names) for (const ean of VARIANT_EANS) assert.ok(!n.includes(ean));
  }
});

// ── guard: canonical internal data is untouched by the projection ─────────────
test("the export projection never mutates the canonical product/variant sku/barcode inputs", () => {
  const p = product("p1", "mk175", { variants: [variant("v1", "mk175-1-red", VARIANT_EANS[0])] });
  const snapshot = JSON.stringify(p);
  buildRafeeqPreview({ products: [p] });
  assert.equal(JSON.stringify(p), snapshot, "input product (incl. variant sku/barcode) is unchanged");
});

// ── cross-product grouping-key corruption still blocks ────────────────────────
test("the same parent-SKU barcode claimed by TWO different products blocks both (corrupted grouping key)", () => {
  const res = buildRafeeqPreview({
    products: [
      product("p1", "mk175", { variants: [variant("v1", "mk175-1-red", VARIANT_EANS[0])] }),
      product("p2", "mk175"), // a DIFFERENT product claiming the same parent SKU
    ],
  });
  assert.ok(res.rows.every((r) => r.status === "BLOCKED" && r.reasons.some((x) => x.code === "DUPLICATE_BARCODE")));
});
