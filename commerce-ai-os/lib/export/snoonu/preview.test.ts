// INT.2C — Snoonu preview tests (pure).
// Proves: product grain, Malikas/Pure Seoul isolation, same product → different
// SPI per store, no cross-store SPI leak, ECL-first identity (never fabricated),
// SKU-based image naming, and the validation matrix.
// node --conditions=react-server --experimental-strip-types --test lib/export/snoonu/preview.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { buildSnoonuPreview, type SnoonuPreviewProduct, type SnoonuMappingEvidence } from "./preview.ts";

function product(over: Partial<SnoonuPreviewProduct> = {}): SnoonuPreviewProduct {
  return {
    id: "p1",
    sku: "MK1",
    barcode: "6291041500213",
    nameEn: "Vitamin C Serum",
    nameAr: "سيروم فيتامين سي",
    category: "Korean Skincare",
    subCategory: "Face",
    price: 75,
    discountPrice: 65,
    descriptionEn: "Bright skin.",
    descriptionAr: "بشرة مشرقة.",
    keywordsEn: "serum, vitamin c",
    keywordsAr: "سيروم",
    imageUrl: "https://cdn.example.com/mk1.jpg",
    imageFilename: null,
    galleryImageUrls: ["https://cdn.example.com/mk1-2.png"],
    imageCount: 2,
    lifecycleState: "ACTIVE",
    platformStatus: "Active",
    ...over,
  };
}
const resolved = (spi: string, productId = "p1"): SnoonuMappingEvidence => ({ status: "resolved", externalId: spi, exportedSku: "MK1", productId });

// ── product grain: one row per product ────────────────────────────────────────
test("Snoonu is product grain — one row per product", () => {
  const res = buildSnoonuPreview({ storefrontKey: "snoonu:malikas", products: [product(), product({ id: "p2", sku: "MK2", barcode: "6291041500220" })] });
  assert.equal(res.rows.length, 2);
  assert.equal(res.preview.grain, "PRODUCT");
  assert.equal(res.rows[0].grain, "PRODUCT");
});

// ── P0: Malikas / Pure Seoul isolation + different SPI per store, no leak ──────
test("same product carries a DIFFERENT SPI per storefront and never leaks across stores", () => {
  const p = product();
  const malikas = buildSnoonuPreview({ storefrontKey: "snoonu:malikas", products: [p], mappingBySku: { mk1: resolved("SPI-MAL-1") } });
  const seoul = buildSnoonuPreview({ storefrontKey: "snoonu:pure_seoul", products: [p], mappingBySku: { mk1: resolved("SPI-SEOUL-9") } });
  assert.equal(malikas.rows[0].spi, "SPI-MAL-1");
  assert.equal(seoul.rows[0].spi, "SPI-SEOUL-9");
  assert.notEqual(malikas.rows[0].spi, seoul.rows[0].spi);
  assert.equal(malikas.rows[0].storefrontKey, "snoonu:malikas");
  assert.equal(seoul.rows[0].storefrontKey, "snoonu:pure_seoul");
});

test("a product mapped on Malikas but NOT on Pure Seoul is unmapped (new) on Pure Seoul — no borrow", () => {
  const p = product();
  const malikas = buildSnoonuPreview({ storefrontKey: "snoonu:malikas", products: [p], mappingBySku: { mk1: resolved("SPI-MAL-1") } });
  const seoul = buildSnoonuPreview({ storefrontKey: "snoonu:pure_seoul", products: [p], mappingBySku: {} });
  assert.equal(malikas.rows[0].spi, "SPI-MAL-1");
  assert.equal(malikas.rows[0].snoonuStatus, "Listed");
  assert.equal(seoul.rows[0].spi, null, "no SPI invented for the unmapped store");
  assert.equal(seoul.rows[0].snoonuStatus, "Not Listed");
  assert.equal(seoul.counts.unmappedCount, 1);
  assert.equal(malikas.counts.mappedCount, 1);
});

// ── ECL-first identity: SPI comes only from the mapping evidence ──────────────
test("SPI is ECL-first — read only from the mapping evidence, never fabricated", () => {
  const unmapped = buildSnoonuPreview({ storefrontKey: "snoonu:malikas", products: [product()] });
  assert.equal(unmapped.rows[0].spi, null);
  assert.equal(unmapped.rows[0].mapping.status, "unmapped");
  const mapped = buildSnoonuPreview({ storefrontKey: "snoonu:malikas", products: [product()], mappingBySku: { mk1: resolved("SPI-42") } });
  assert.equal(mapped.rows[0].spi, "SPI-42");
});

// ── SKU-based image naming (never title-based) ────────────────────────────────
test("image export filename is derived from the SKU", () => {
  const res = buildSnoonuPreview({ storefrontKey: "snoonu:malikas", products: [product({ sku: "MK-1000", imageUrl: "https://cdn/a.webp" })] });
  assert.equal(res.rows[0].imageExportName, "MK-1000.webp");
  assert.ok(!/serum|vitamin/i.test(res.rows[0].imageExportName ?? ""), "never title-based");
});

// ── validation matrix ─────────────────────────────────────────────────────────
const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);

test("missing SKU blocks; duplicate SKU across the dataset blocks", () => {
  const missing = buildSnoonuPreview({ storefrontKey: "snoonu:malikas", products: [product({ sku: null })] });
  assert.equal(missing.rows[0].status, "BLOCKED");
  assert.ok(codes(missing.rows[0]).includes("MISSING_SKU"));
  const dup = buildSnoonuPreview({ storefrontKey: "snoonu:malikas", products: [product({ id: "a", sku: "DUP" }), product({ id: "b", sku: "DUP", barcode: "6291041500999" })] });
  assert.ok(dup.rows.every((r) => codes(r).includes("DUPLICATE_SKU") && r.status === "BLOCKED"));
});

test("missing barcode WARNS; duplicate barcode BLOCKS; bad format WARNS", () => {
  const missing = buildSnoonuPreview({ storefrontKey: "snoonu:malikas", products: [product({ barcode: null })] });
  assert.equal(missing.rows[0].status, "WARNING");
  assert.ok(missing.rows[0].reasons.some((x) => x.code === "MISSING_BARCODE" && !x.blocking));
  const dup = buildSnoonuPreview({ storefrontKey: "snoonu:malikas", products: [product({ id: "a", sku: "A", barcode: "6291041500213" }), product({ id: "b", sku: "B", barcode: "6291041500213" })] });
  assert.ok(dup.rows.every((r) => r.status === "BLOCKED" && codes(r).includes("DUPLICATE_BARCODE")));
  const bad = buildSnoonuPreview({ storefrontKey: "snoonu:malikas", products: [product({ barcode: "12" })] });
  assert.ok(bad.rows[0].reasons.some((x) => x.code === "INVALID_BARCODE" && !x.blocking));
});

test("missing image / title block; missing price / category warn", () => {
  const noImg = buildSnoonuPreview({ storefrontKey: "snoonu:malikas", products: [product({ imageUrl: null, imageFilename: null, imageCount: 0, galleryImageUrls: [] })] });
  assert.ok(noImg.rows[0].status === "BLOCKED" && codes(noImg.rows[0]).includes("MISSING_IMAGE"));
  const noTitle = buildSnoonuPreview({ storefrontKey: "snoonu:malikas", products: [product({ nameEn: null, nameAr: null })] });
  assert.ok(noTitle.rows[0].status === "BLOCKED" && codes(noTitle.rows[0]).includes("MISSING_TITLE"));
  const warns = buildSnoonuPreview({ storefrontKey: "snoonu:malikas", products: [product({ price: null, discountPrice: null, category: null })] });
  assert.equal(warns.rows[0].status, "WARNING");
  assert.ok(codes(warns.rows[0]).includes("MISSING_PRICE") && codes(warns.rows[0]).includes("MISSING_CATEGORY"));
});

test("STOPPED lifecycle blocks (not eligible)", () => {
  const res = buildSnoonuPreview({ storefrontKey: "snoonu:malikas", products: [product({ lifecycleState: "STOPPED", platformStatus: "Stopped" })] });
  assert.ok(res.rows[0].status === "BLOCKED" && codes(res.rows[0]).includes("LIFECYCLE_NOT_ELIGIBLE"));
});

test("identity conflict blocks; needs_review warns", () => {
  // ECL maps this SKU to a DIFFERENT product on this storefront → conflict
  const conflict = buildSnoonuPreview({ storefrontKey: "snoonu:malikas", products: [product()], mappingBySku: { mk1: { status: "resolved", externalId: "SPI-X", exportedSku: "MK1", productId: "OTHER" } } });
  assert.ok(conflict.rows[0].status === "BLOCKED" && codes(conflict.rows[0]).includes("IDENTITY_CONFLICT"));
  const review = buildSnoonuPreview({ storefrontKey: "snoonu:malikas", products: [product()], mappingBySku: { mk1: { status: "needs_review", externalId: "SPI-Y", exportedSku: "MK1", productId: "p1" } } });
  assert.ok(review.rows[0].reasons.some((x) => x.code === "IDENTITY_NEEDS_REVIEW" && !x.blocking));
  assert.equal(review.rows[0].snoonuStatus, "Needs Review");
});

test("a complete mapped product is READY with no reasons", () => {
  const res = buildSnoonuPreview({ storefrontKey: "snoonu:malikas", products: [product()], mappingBySku: { mk1: resolved("SPI-1") } });
  assert.equal(res.rows[0].status, "READY");
  assert.equal(res.rows[0].reasons.length, 0);
});
