// Rafeeq native-option preview tests (pure).
// Proves: canonical rafeeq:malikas destination, PRODUCT grain (one identity per
// canonical product), ECL-first identity (never fabricated), mapped/unmapped/
// new, needs_review => BLOCKED (no auto-resolution), parent-SKU image naming,
// filename-collision block, and the validation matrix incl. STOPPED lifecycle.
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/preview.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { buildRafeeqPreview, RAFEEQ_STOREFRONT_KEY, type RafeeqPreviewProduct, type RafeeqMappingEvidence } from "./preview.ts";

function product(over: Partial<RafeeqPreviewProduct> = {}): RafeeqPreviewProduct {
  return {
    id: "p1", sku: "MK1", barcode: "6291041500213", nameEn: "Serum", nameAr: "سيروم",
    category: "Makeup", price: 75, discountPrice: 65, descriptionEn: "Bright.", descriptionAr: "مشرق.",
    imageUrl: "https://cdn.example.com/mk1.jpg", imageFilename: null,
    galleryImageUrls: ["https://cdn.example.com/mk1-2.png"], imageCount: 2,
    lifecycleState: "ACTIVE", platformStatus: "Active", ...over,
  };
}
const resolved = (id: string, productId = "p1"): RafeeqMappingEvidence => ({ status: "resolved", externalId: id, exportedSku: "MK1", productId });
const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);

test("canonical rafeeq:malikas destination; PRODUCT-grain dataset (one row per canonical product)", () => {
  const res = buildRafeeqPreview({ products: [product()] });
  assert.equal(res.storefrontKey, RAFEEQ_STOREFRONT_KEY);
  assert.equal(res.preview.grain, "PRODUCT");
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].rowKey, "p1");
  assert.equal(res.rows[0].optionCount, 0);
  assert.equal(res.counts.physicalRowCount, 1);
});

test("ECL-first identity: the Rafeeq product_id comes from the mapping, never fabricated", () => {
  const mapped = buildRafeeqPreview({ products: [product()], mappingBySku: { mk1: resolved("691300001") } });
  assert.equal(mapped.rows[0].rafeeqId, "691300001");
  assert.equal(mapped.counts.mappedCount, 1);
  const unmapped = buildRafeeqPreview({ products: [product()] });
  assert.equal(unmapped.rows[0].rafeeqId, null, "new/unmapped → no id invented");
  assert.equal(unmapped.counts.unmappedCount, 1);
});

test("needs_review is BLOCKED and never auto-resolved (identity stays unusable)", () => {
  const res = buildRafeeqPreview({ products: [product()], mappingBySku: { mk1: { status: "needs_review", externalId: "691300999", exportedSku: "MK1", productId: "p1" } } });
  const r = res.rows[0];
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.needsOwnerReview, true);
  assert.ok(codes(r).includes("IDENTITY_NEEDS_REVIEW"));
  assert.equal(r.rafeeqId, null, "a contested claimed id is NEVER promoted to the active identity");
  assert.equal(res.counts.needsReviewCount, 1);
});

test("cross-product ECL mapping blocks (identity conflict, no similarity matching)", () => {
  const res = buildRafeeqPreview({ products: [product()], mappingBySku: { mk1: resolved("691300009", "OTHER") } });
  assert.ok(res.rows[0].status === "BLOCKED" && codes(res.rows[0]).includes("IDENTITY_CONFLICT"));
});

test("image export filename derives from the PARENT SKU (never the title)", () => {
  const res = buildRafeeqPreview({ products: [product({ sku: "MK-77", imageUrl: "https://cdn/a.webp" })] });
  assert.equal(res.rows[0].imageExportName, "MK-77.webp");
  assert.ok(!/serum/i.test(res.rows[0].imageExportName ?? ""));
});

test("post-sanitization filename collision between distinct products blocks both", () => {
  // "mk/1" and "mk-1" both sanitize to mk-1.jpg
  const res = buildRafeeqPreview({ products: [
    product({ id: "a", sku: "mk/1" }),
    product({ id: "b", sku: "mk-1" }),
  ] });
  assert.ok(res.rows.every((r) => r.status === "BLOCKED" && codes(r).includes("IDENTITY_CONFLICT")));
});

test("validation matrix: sku/title/image block; price/category warn; the barcode is the parent SKU", () => {
  assert.ok(buildRafeeqPreview({ products: [product({ nameEn: null, nameAr: null })] }).rows[0].status === "BLOCKED");
  assert.ok(buildRafeeqPreview({ products: [product({ imageUrl: null, imageFilename: null, imageCount: 0, galleryImageUrls: [] })] }).rows[0].status === "BLOCKED");
  // a missing EAN is irrelevant to Rafeeq — the barcode cell is the parent SKU
  const warns = buildRafeeqPreview({ products: [product({ barcode: null, price: null, discountPrice: null, category: null })] }).rows[0];
  assert.equal(warns.status, "WARNING");
  for (const c of ["MISSING_PRICE", "MISSING_CATEGORY"]) assert.ok(codes(warns).includes(c));
  assert.equal(codes(warns).includes("MISSING_BARCODE"), false, "no EAN needed — barcode = parent SKU");
  assert.equal(warns.barcode, "MK1");
  // a missing product SKU means neither the sku nor the barcode cell can be filled
  const noSku = buildRafeeqPreview({ products: [product({ sku: null })] }).rows[0];
  assert.equal(noSku.status, "BLOCKED");
  assert.ok(codes(noSku).includes("MISSING_SKU") && codes(noSku).includes("MISSING_BARCODE"));
  // two DIFFERENT products claiming one parent SKU ⇒ corrupted identity + grouping key
  const dup = buildRafeeqPreview({ products: [product({ id: "a", sku: "DUP" }), product({ id: "b", sku: "DUP" })] });
  assert.ok(dup.rows.every((r) => r.status === "BLOCKED" && codes(r).includes("DUPLICATE_SKU") && codes(r).includes("DUPLICATE_BARCODE")));
  // identical EANs alone never matter (the EAN is not exported)
  const sameEan = buildRafeeqPreview({ products: [product({ id: "a", sku: "A", barcode: "629104" }), product({ id: "b", sku: "B", barcode: "629104" })] });
  assert.ok(sameEan.rows.every((r) => !codes(r).includes("DUPLICATE_BARCODE")));
});

test("STOPPED lifecycle is not exportable (blocked)", () => {
  const res = buildRafeeqPreview({ products: [product({ lifecycleState: "STOPPED", platformStatus: "Stopped" })] });
  assert.ok(res.rows[0].status === "BLOCKED" && codes(res.rows[0]).includes("LIFECYCLE_NOT_ELIGIBLE"));
});

test("a complete mapped product is READY", () => {
  const res = buildRafeeqPreview({ products: [product()], mappingBySku: { mk1: resolved("691300001") } });
  assert.equal(res.rows[0].status, "READY");
  assert.equal(res.rows[0].reasons.length, 0);
});
