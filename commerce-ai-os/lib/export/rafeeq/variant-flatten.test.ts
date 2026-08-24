// RAFEEQ.FULLSYNC.2 — sellable-listing flattening tests (spec scenarios 1–13).
// Simple product ⇒ exactly one row; variant product ⇒ one row per legitimate
// variant and NO parent row; variant rows carry their OWN sku/barcode/price and
// inherit the parent's category/descriptions/images (packaged under the VARIANT
// sku filename).
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/variant-flatten.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { buildRafeeqPreview, type RafeeqPreviewProduct, type RafeeqPreviewVariant } from "./preview.ts";
import { planRowImages, toPackageRow, buildRafeeqXlsxAoa, checkReferentialIntegrity, primaryFilenameFor, type PackagedFile } from "./package.ts";
import { applyFullSyncRafeeqId } from "./fullsync.ts";

let bc = 620000;
function variant(id: string, sku: string, over: Partial<RafeeqPreviewVariant> = {}): RafeeqPreviewVariant {
  bc += 1;
  return { id, sku, barcode: String(bc), nameEn: `Blue ${id}`, nameAr: `أزرق ${id}`, price: null, ...over };
}
function product(id: string, sku: string, over: Partial<RafeeqPreviewProduct> = {}): RafeeqPreviewProduct {
  bc += 1;
  return {
    id, sku, barcode: String(bc),
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

// ── 1) simple product ⇒ exactly one row ───────────────────────────────────────
test("1: a simple product exports exactly ONE row (grain PRODUCT)", () => {
  const res = buildRafeeqPreview({ products: [product("p1", "mk1")] });
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].grain, "PRODUCT");
  assert.equal(res.rows[0].isVariant, false);
  assert.equal(res.counts.sellableRowCount, 1);
  assert.equal(res.counts.simpleRowCount, 1);
  assert.equal(res.counts.variantRowCount, 0);
  assert.equal(res.counts.productsWithVariants, 0);
});

// ── 2 + 11) two-variant product ⇒ exactly two rows, NO parent row ─────────────
test("2/11: a 2-variant product exports exactly TWO rows and never a parent row", () => {
  const res = buildRafeeqPreview({
    products: [product("p1", "mk10", { variants: [variant("v1", "mk10-1"), variant("v2", "mk10-2")] })],
  });
  assert.equal(res.rows.length, 2, "no parent+variant double export");
  assert.ok(res.rows.every((r) => r.grain === "VARIANT" && r.isVariant));
  assert.deepEqual(res.rows.map((r) => r.sku), ["mk10-1", "mk10-2"]);
  assert.equal(res.rows.some((r) => r.sku === "mk10"), false, "the parent SKU never appears as a sellable row");
  assert.deepEqual(res.rows.map((r) => r.rowKey), ["p1::v1", "p1::v2"], "unique sellable row keys");
  assert.equal(res.counts.sellableRowCount, 2);
  assert.equal(res.counts.variantRowCount, 2);
  assert.equal(res.counts.simpleRowCount, 0);
  assert.equal(res.counts.productsWithVariants, 1);
});

// ── 3 + 4) variant sku/barcode are the VARIANT's own ──────────────────────────
test("3/4: variant rows export the variant's OWN sku and barcode (never the parent's)", () => {
  const res = buildRafeeqPreview({
    products: [product("p1", "mk10", { barcode: "111111", variants: [variant("v1", "mk10-1", { barcode: "222333" })] })],
  });
  const r = res.rows[0];
  assert.equal(r.sku, "mk10-1");
  assert.equal(r.barcode, "222333");
  const aoa = buildRafeeqXlsxAoa([toPackageRow(r, "mk10-1.jpg")]);
  assert.equal(aoa[1][8], "222333", "BARCODE column carries the variant barcode");
  // a variant WITHOUT its own sku is blocked — no parent fallback
  const missing = rowsOf([product("p2", "mk20", { variants: [variant("v9", "", {})] })])[0];
  assert.equal(missing.status, "BLOCKED");
  const codes = missing.reasons.map((x) => x.code);
  assert.ok(codes.includes("MISSING_SKU") && codes.includes("VARIANT_NOT_READY"));
});

// ── 5–7) canonical variant sell price ─────────────────────────────────────────
test("5: an explicit positive variant price beats the parent discount AND parent price", () => {
  const r = rowsOf([product("p1", "mk10", { price: 100, discountPrice: 80, variants: [variant("v1", "mk10-1", { price: 65 })] })])[0];
  assert.equal(r.price, 65);
});
test("6: a variant without its own price inherits the parent DISCOUNT price first", () => {
  const r = rowsOf([product("p1", "mk10", { price: 100, discountPrice: 80, variants: [variant("v1", "mk10-1", { price: null })] })])[0];
  assert.equal(r.price, 80);
});
test("7: with no variant price and no discount, the variant inherits the parent price", () => {
  const rows = rowsOf([product("p1", "mk10", { price: 100, discountPrice: null, variants: [variant("v1", "mk10-1", { price: 0 })] })]);
  assert.equal(rows[0].price, 100, "a zero/absent variant price is never used as the sell price");
});

// ── 8) parent category/descriptions inherited; certified flattened names ──────
test("8: variant rows inherit the parent category + descriptions and use the certified flattened names", () => {
  const r = rowsOf([product("p1", "mk10", { variants: [variant("v1", "mk10-1", { nameEn: "Rose Gold", nameAr: "ذهبي وردي" })] })])[0];
  assert.equal(r.category, "Makeup");
  assert.equal(r.descriptionEn, "Parent EN description.");
  assert.equal(r.descriptionAr, "وصف الأصل.");
  assert.equal(r.title, "Parent mk10 — Rose Gold");
  assert.equal(r.titleAr, "الأصل mk10 — ذهبي وردي");
  // Arabic falls back to the safe canonical variant display name when no Arabic name exists
  const noAr = rowsOf([product("p2", "mk20", { variants: [variant("v2", "mk20-1", { nameEn: "Matte", nameAr: null })] })])[0];
  assert.equal(noAr.titleAr, "الأصل mk20 — Matte");
});

// ── 9) shared parent image packaged under each VARIANT sku ────────────────────
test("9: the shared parent image is planned under EACH variant's own SKU filename", () => {
  const rows = rowsOf([product("p1", "mk10", {
    imageUrl: "https://cdn.example.com/parent.jpg",
    galleryImageUrls: ["https://cdn.example.com/parent-extra.png"],
    imageCount: 2,
    variants: [variant("v1", "mk10-1"), variant("v2", "mk10-2")],
  })]);
  const plans = rows.map(planRowImages);
  assert.deepEqual(plans.map((p) => p.primary?.filename), ["mk10-1.jpg", "mk10-2.jpg"], "variant-SKU filenames");
  assert.deepEqual(plans.map((p) => p.primary?.sourceUrl), ["https://cdn.example.com/parent.jpg", "https://cdn.example.com/parent.jpg"],
    "same parent source bytes, deliberately duplicated per sibling");
  // inherited gallery is repackaged under the variant sku too (SKU_2.ext convention)
  assert.deepEqual(plans[0].gallery.map((g) => g.filename), ["mk10-1_2.png"]);
  assert.ok(rows.every((r) => r.inheritedParentImage));
  assert.ok(rows.every((r) => r.reasons.some((x) => x.code === "IMAGE_SHARED_FROM_PRODUCT" && !x.blocking)), "disclosed, never blocking");
});

// ── 10) variant image ↔ XLSX referential integrity ────────────────────────────
test("10: variant rows + their packaged images pass referential integrity (per-variant filenames)", () => {
  const rows = rowsOf([product("p1", "mk10", { variants: [variant("v1", "mk10-1"), variant("v2", "mk10-2")] })]);
  const packageRows = rows.map((r) => applyFullSyncRafeeqId(toPackageRow(r, primaryFilenameFor(r.sku, "jpg")), r, "FULL"));
  const packaged: PackagedFile[] = rows.map((r) => ({ name: primaryFilenameFor(r.sku, "jpg"), kind: "primary" as const }));
  const integrity = checkReferentialIntegrity(packageRows.map((r) => r.imageName), packaged);
  assert.equal(integrity.ok, true);
  assert.deepEqual(packageRows.map((r) => r.imageName), ["mk10-1.jpg", "mk10-2.jpg"]);
  assert.ok(packageRows.every((r) => r.rafeeqId === "new product"));
});

// ── 12) duplicate SKU detection across the FINAL flattened dataset ────────────
test("12: a variant SKU colliding with ANOTHER product's sellable SKU blocks both rows", () => {
  const res = buildRafeeqPreview({
    products: [
      product("p1", "mk10", { variants: [variant("v1", "DUP-SKU")] }),
      product("p2", "DUP-SKU"),
    ],
  });
  assert.equal(res.rows.length, 2);
  assert.ok(res.rows.every((r) => r.status === "BLOCKED" && r.reasons.some((x) => x.code === "DUPLICATE_SKU")));
});

// ── 13) duplicate barcode detection across the FINAL flattened dataset ────────
test("13: a variant barcode colliding with ANOTHER sellable row's barcode blocks both rows", () => {
  const res = buildRafeeqPreview({
    products: [
      product("p1", "mk10", { variants: [variant("v1", "mk10-1", { barcode: "999888" })] }),
      product("p2", "mk20", { barcode: "999888" }),
    ],
  });
  assert.ok(res.rows.every((r) => r.status === "BLOCKED" && r.reasons.some((x) => x.code === "DUPLICATE_BARCODE")));
  // sibling variants with distinct barcodes stay clean
  const ok = buildRafeeqPreview({ products: [product("p3", "mk30", { variants: [variant("v1", "mk30-1"), variant("v2", "mk30-2")] })] });
  assert.ok(ok.rows.every((r) => !r.reasons.some((x) => x.code === "DUPLICATE_BARCODE")));
});

// ── STOPPED parent blocks its variant rows ────────────────────────────────────
test("a STOPPED parent lifecycle blocks every one of its variant rows", () => {
  const rows = rowsOf([product("p1", "mk10", { lifecycleState: "STOPPED", variants: [variant("v1", "mk10-1"), variant("v2", "mk10-2")] })]);
  assert.ok(rows.every((r) => r.status === "BLOCKED" && r.reasons.some((x) => x.code === "LIFECYCLE_NOT_ELIGIBLE")));
});

// ── production shape: 1357 simple + 62 variant products (197 variants) = 1554 ─
test("flattening arithmetic: simple + variant rows = expected sellable total", () => {
  const products: RafeeqPreviewProduct[] = [];
  for (let i = 0; i < 8; i++) products.push(product(`s${i}`, `mk-s${i}`));
  products.push(product("m1", "mk-m1", { variants: [variant("m1v1", "mk-m1-1"), variant("m1v2", "mk-m1-2"), variant("m1v3", "mk-m1-3")] }));
  products.push(product("m2", "mk-m2", { variants: [variant("m2v1", "mk-m2-1"), variant("m2v2", "mk-m2-2")] }));
  const res = buildRafeeqPreview({ products });
  assert.equal(res.counts.productCount, 10);
  assert.equal(res.counts.simpleRowCount, 8);
  assert.equal(res.counts.variantRowCount, 5);
  assert.equal(res.counts.sellableRowCount, 13); // 8 + 5, parents never double-counted
  assert.equal(res.counts.productsWithVariants, 2);
});
