// INT.2B — Talabat sellable-listing preview (PURE) tests.
// Proves the P0 invariants (§13): simple product → exactly 1 row; a 3-variant
// product → 3 independent rows and NO parent row; each variant uses its OWN SKU
// (never the parent SKU); each variant image filename is derived from that
// variant's SKU. Plus the validation matrix, dataset-wide duplicate detection,
// mapping evidence, and the summary.
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/preview.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTalabatPreview,
  type TalabatPreviewProduct,
  type TalabatPreviewInput,
} from "./preview.ts";

// ── fixtures ──────────────────────────────────────────────────────────────────
function product(over: Partial<TalabatPreviewProduct> = {}): TalabatPreviewProduct {
  return {
    id: "p1",
    sku: "MK1000",
    barcode: "1234567890",
    nameEn: "Serum",
    nameAr: "سيروم",
    price: 50,
    discountPrice: null,
    category: "Skincare",
    imageUrl: "https://cdn/x/pic.jpg",
    imageFilename: null,
    imageCount: 1,
    approved: true,
    lifecycleState: "ACTIVE",
    platformStatus: "Active",
    variants: [],
    ...over,
  };
}

const APPROVED_ACTIVE = { approved: true, lifecycleState: "ACTIVE", platformStatus: "Active" } as const;

// ── §13 P0: simple product → exactly one sellable row ─────────────────────────
test("simple product produces exactly one sellable row", () => {
  const res = buildTalabatPreview({ products: [product()] });
  assert.equal(res.rows.length, 1);
  assert.equal(res.counts.productCount, 1);
  assert.equal(res.counts.variantCount, 0);
  assert.equal(res.counts.sellableRowCount, 1);
  const row = res.rows[0]!;
  assert.equal(row.isVariant, false);
  assert.equal(row.variantId, null);
  assert.equal(row.grain, "SELLABLE_LISTING");
  assert.equal(row.sku, "MK1000");
});

// ── §13 P0: 3 variants → 3 independent rows, NO parent row ────────────────────
test("a 3-variant product produces 3 independent rows and NO parent row", () => {
  const p = product({
    id: "p2",
    sku: "MK1002",
    variants: [
      { id: "v1", sku: "MK1002-RED", barcode: "1111111111", nameEn: "Red", nameAr: "أحمر", price: 60 },
      { id: "v2", sku: "MK1002-BLUE", barcode: "2222222222", nameEn: "Blue", nameAr: "أزرق", price: 60 },
      { id: "v3", sku: "MK1002-GREEN", barcode: "3333333333", nameEn: "Green", nameAr: "أخضر", price: 60 },
    ],
  });
  const res = buildTalabatPreview({ products: [p] });

  assert.equal(res.rows.length, 3, "one row per variant");
  assert.equal(res.counts.variantCount, 3);
  assert.equal(res.counts.sellableRowCount, 3);
  // every row is a variant row → NO parent row exists
  assert.ok(res.rows.every((r) => r.isVariant === true), "no parent row");
  assert.ok(res.rows.every((r) => r.variantId !== null));
  // parent SKU never appears as a row's sellable SKU
  assert.ok(res.rows.every((r) => r.sku !== "MK1002"), "parent SKU is never a row SKU");
});

// ── §13 P0 + §4: each variant uses its OWN SKU (no parent fallback) ────────────
test("each variant row uses its own SKU; a missing variant SKU never falls back to parent", () => {
  const p = product({
    id: "p3",
    sku: "PARENT",
    variants: [
      { id: "v1", sku: "CHILD-A", barcode: "1234567890", nameEn: "A", nameAr: "أ", price: 10 },
      { id: "v2", sku: null, barcode: "1234567899", nameEn: "B", nameAr: "ب", price: 10 },
    ],
  });
  const res = buildTalabatPreview({ products: [p] });
  const [a, b] = res.rows;
  assert.equal(a!.sku, "CHILD-A");
  // missing variant SKU stays empty (NOT "PARENT") and blocks
  assert.equal(b!.sku, "");
  assert.notEqual(b!.sku, "PARENT");
  assert.equal(b!.status, "BLOCKED");
  const codes = b!.reasons.map((r) => r.code);
  assert.ok(codes.includes("MISSING_SKU"));
  assert.ok(codes.includes("VARIANT_NOT_READY"));
});

// ── §13 P0 + §6: variant image filename derives from the VARIANT SKU ──────────
test("each variant image filename uses that variant's SKU (never the parent SKU or title)", () => {
  const p = product({
    id: "p4",
    sku: "MK1002",
    nameEn: "Lipstick",
    imageUrl: "https://cdn/x/pic.png",
    variants: [
      { id: "v1", sku: "mk1002-red", barcode: "1111111111", nameEn: "Red", nameAr: "أحمر", price: 60 },
      { id: "v2", sku: "mk1002-blue", barcode: "2222222222", nameEn: "Blue", nameAr: "أزرق", price: 60 },
    ],
  });
  const res = buildTalabatPreview({ products: [p] });
  assert.equal(res.rows[0]!.imageExportName, "mk1002-red.png");
  assert.equal(res.rows[1]!.imageExportName, "mk1002-blue.png");
  // never the parent SKU, never the product title
  assert.ok(res.rows.every((r) => r.imageExportName !== "MK1002.png"));
  assert.ok(res.rows.every((r) => !/lipstick/i.test(r.imageExportName ?? "")));
  // variants inherit the parent image (no per-variant image column exists)
  assert.ok(res.rows.every((r) => r.inheritedParentImage === true));
});

test("simple product image filename uses the product SKU (primary naming)", () => {
  const res = buildTalabatPreview({ products: [product({ sku: "MK1000", imageUrl: "https://cdn/a.webp" })] });
  assert.equal(res.rows[0]!.imageExportName, "MK1000.webp");
  assert.equal(res.rows[0]!.inheritedParentImage, false);
});

// ── variant sharing the product image is DISCLOSED (warning), never blocked ────
test("a variant using the product image is WARNING with IMAGE_SHARED_FROM_PRODUCT, not blocked", () => {
  const res = buildTalabatPreview({
    products: [product({
      sku: "MK2000",
      imageUrl: "https://cdn/x/pic.jpg",
      variants: [{ id: "v1", sku: "mk2000-red", barcode: "9990001112", nameEn: "Red", nameAr: "أحمر", price: 40 }],
    })],
  });
  const r = res.rows[0]!;
  assert.equal(r.isVariant, true);
  assert.equal(r.status, "WARNING", "shared image discloses a warning, never blocks");
  assert.ok(r.reasons.some((x) => x.code === "IMAGE_SHARED_FROM_PRODUCT" && !x.blocking));
  // it is NOT a MISSING_IMAGE and there is no MISSING_VARIANT_IMAGE concept
  assert.ok(!r.reasons.some((x) => x.code === "MISSING_IMAGE"));
  assert.equal(r.hasImage, true);
});

// ── §3: title reuses the certified flattened-name projection ──────────────────
test("variant title reuses the certified buildFlattenedName projection", () => {
  const p = product({
    nameEn: "Serum",
    variants: [{ id: "v1", sku: "S-1", barcode: "1234567890", nameEn: "30ml", nameAr: "", price: 10 }],
  });
  const res = buildTalabatPreview({ products: [p] });
  assert.equal(res.rows[0]!.title, "Serum — 30ml");
});

// ── §4/§10: duplicate SKU across the FINAL flattened dataset blocks all copies ─
test("duplicate SKU is detected across the whole flattened dataset (cross-product)", () => {
  const a = product({ id: "pa", sku: "DUP", barcode: "1111111111" });
  const b = product({ id: "pb", sku: "dup", barcode: "2222222222" }); // case-insensitive collision
  const res = buildTalabatPreview({ products: [a, b] });
  assert.ok(res.rows.every((r) => r.reasons.some((x) => x.code === "DUPLICATE_SKU")));
  assert.ok(res.rows.every((r) => r.status === "BLOCKED"));
});

test("duplicate barcode is detected across the flattened dataset", () => {
  const a = product({ id: "pa", sku: "A", barcode: "9999999999" });
  const b = product({ id: "pb", sku: "B", barcode: "9999999999" });
  const res = buildTalabatPreview({ products: [a, b] });
  assert.ok(res.rows.every((r) => r.reasons.some((x) => x.code === "DUPLICATE_BARCODE")));
});

// ── §5: barcode statuses ──────────────────────────────────────────────────────
test("missing barcode blocks; non-standard barcode format is a WARNING only", () => {
  const missing = buildTalabatPreview({ products: [product({ id: "m", sku: "M1", barcode: null })] });
  assert.ok(missing.rows[0]!.reasons.some((r) => r.code === "MISSING_BARCODE" && r.blocking));
  assert.equal(missing.rows[0]!.status, "BLOCKED");

  const invalid = buildTalabatPreview({ products: [product({ id: "i", sku: "I1", barcode: "ABC" })] });
  const r = invalid.rows[0]!;
  assert.ok(r.reasons.some((x) => x.code === "INVALID_BARCODE" && !x.blocking));
  assert.equal(r.status, "WARNING", "invalid format alone does not block");
});

// ── §6/§7: no product image at all blocks the row ─────────────────────────────
test("a row with no product image at all is BLOCKED (MISSING_IMAGE)", () => {
  const res = buildTalabatPreview({
    products: [product({ id: "n", sku: "N1", imageUrl: null, imageFilename: null, imageCount: 0 })],
  });
  assert.ok(res.rows[0]!.reasons.some((r) => r.code === "MISSING_IMAGE" && r.blocking));
});

// ── §8: lifecycle eligibility ─────────────────────────────────────────────────
test("STOPPED / non-approved products are not eligible (LIFECYCLE_NOT_ELIGIBLE, blocking)", () => {
  const stopped = buildTalabatPreview({
    products: [product({ id: "s", sku: "S1", lifecycleState: "STOPPED", platformStatus: "Stopped" })],
  });
  assert.ok(stopped.rows[0]!.reasons.some((r) => r.code === "LIFECYCLE_NOT_ELIGIBLE" && r.blocking));

  const notApproved = buildTalabatPreview({ products: [product({ id: "na", sku: "NA1", approved: false })] });
  assert.ok(notApproved.rows[0]!.reasons.some((r) => r.code === "LIFECYCLE_NOT_ELIGIBLE" && r.blocking));
});

// ── §9: a fully-valid row is READY with no reasons ────────────────────────────
test("a complete, approved, active, mapped row is READY", () => {
  const res = buildTalabatPreview({ products: [product({ ...APPROVED_ACTIVE })] });
  const r = res.rows[0]!;
  assert.equal(r.status, "READY");
  assert.equal(r.reasons.length, 0);
});

// ── price / category are warnings, not blocks ─────────────────────────────────
test("missing price / category are WARNING only", () => {
  const res = buildTalabatPreview({
    products: [product({ id: "w", sku: "W1", price: null, discountPrice: null, category: null })],
  });
  const r = res.rows[0]!;
  assert.equal(r.status, "WARNING");
  assert.ok(r.reasons.some((x) => x.code === "MISSING_PRICE" && !x.blocking));
  assert.ok(r.reasons.some((x) => x.code === "MISSING_CATEGORY" && !x.blocking));
});

// ── §11: mapping evidence (no fabricated ids) ─────────────────────────────────
test("mapping evidence comes from ECL keyed by lower(sku); absent ⇒ unmapped with no id", () => {
  const input: TalabatPreviewInput = {
    products: [product({ id: "p", sku: "MK-XYZ" })],
    mappingBySku: { "mk-xyz": { status: "resolved", externalId: "tlb-9", exportedSku: "MK-XYZ" } },
  };
  const res = buildTalabatPreview(input);
  assert.equal(res.rows[0]!.mapping.status, "resolved");
  assert.equal(res.rows[0]!.mapping.externalId, "tlb-9");

  const unmapped = buildTalabatPreview({ products: [product({ id: "u", sku: "NOPE" })] });
  assert.equal(unmapped.rows[0]!.mapping.status, "unmapped");
  assert.equal(unmapped.rows[0]!.mapping.externalId, null);
});

test("an unmapped row can still be READY (mapping is evidence, not a gate)", () => {
  const res = buildTalabatPreview({ products: [product({ ...APPROVED_ACTIVE })] });
  assert.equal(res.rows[0]!.mapping.status, "unmapped");
  assert.equal(res.rows[0]!.status, "READY");
});

// ── summary reflects the flattened items ──────────────────────────────────────
test("summary counts the flattened rows and groups reasons", () => {
  const ready = product({ id: "r", sku: "R1", barcode: "1234567890", ...APPROVED_ACTIVE });
  const blocked = product({ id: "b", sku: "", barcode: null, ...APPROVED_ACTIVE });
  const res = buildTalabatPreview({ products: [ready, blocked] });
  assert.equal(res.summary.total, 2);
  assert.equal(res.summary.ready, 1);
  assert.equal(res.summary.blocked, 1);
  assert.ok((res.summary.byReason.MISSING_SKU ?? 0) >= 1);
});

// ── preview projection uses SELLABLE_LISTING grain, not a placeholder ─────────
test("preview is a real SELLABLE_LISTING projection (placeholder:false)", () => {
  const res = buildTalabatPreview({ products: [product()] });
  assert.equal(res.preview.grain, "SELLABLE_LISTING");
  assert.equal(res.preview.placeholder, false);
  assert.equal(res.preview.items.length, res.rows.length);
  assert.equal(res.preview.items[0]!.externalIdentity?.identityType, "talabat_sku");
});

// ── empty input is total & safe ───────────────────────────────────────────────
test("empty product list yields an empty, valid result", () => {
  const res = buildTalabatPreview({ products: [] });
  assert.equal(res.rows.length, 0);
  assert.equal(res.summary.total, 0);
  assert.equal(res.counts.sellableRowCount, 0);
});
