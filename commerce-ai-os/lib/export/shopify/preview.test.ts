// INT.2E — Shopify preview tests (pure).
// Proves: canonical shopify:malikas destination + product grain, ECL-first GID
// identity (never fabricated, never name-matched), the MATCH / NEW /
// UPDATE_REQUIRED / CONFLICT / BLOCKED / UNKNOWN matrix, provable field & variant
// diffs, the CONFLICT rules (§10), no auto-publish (status never actionable), and
// the deterministic future mutation plan (§12).
// node --conditions=react-server --experimental-strip-types --test lib/export/shopify/preview.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildShopifyPreview,
  SHOPIFY_STOREFRONT_KEY,
  type ShopifyInternalProduct,
  type ShopifyLiveProduct,
  type ShopifyIdentityEvidence,
} from "./preview.ts";

function product(over: Partial<ShopifyInternalProduct> = {}): ShopifyInternalProduct {
  return {
    id: "p1", sku: "SKU1", barcode: "6291041500213", nameEn: "Serum", nameAr: "سيروم",
    descriptionEn: "Bright serum.", descriptionAr: "مشرق.", price: 100, discountPrice: 80,
    imageUrl: "https://cdn.example.com/x.jpg", imageFilename: null, imageCount: 1,
    variants: [], lifecycleState: "active", platformStatus: "Active", ...over,
  };
}
function liveProduct(over: Partial<ShopifyLiveProduct> = {}): ShopifyLiveProduct {
  return {
    id: "gid://shopify/Product/1", title: "Serum", status: "ACTIVE",
    descriptionHtml: "<p>Bright serum.</p>", imageUrl: "https://cdn.shopify/x.jpg",
    variants: [{ id: "gid://shopify/ProductVariant/11", sku: "SKU1", barcode: "6291041500213", price: "80.00", compareAtPrice: "100.00", inventoryQuantity: 5 }],
    ...over,
  };
}
const mapped = (gid = "gid://shopify/Product/1", variantGidByVariantId: Record<string, string> = {}): ShopifyIdentityEvidence =>
  ({ status: "active", productGid: gid, variantGidByVariantId });
const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);

test("canonical shopify:malikas destination, product grain", () => {
  const res = buildShopifyPreview({ products: [product()], live: [] });
  assert.equal(res.storefrontKey, SHOPIFY_STOREFRONT_KEY);
  assert.equal(res.preview.grain, "PRODUCT");
  assert.equal(res.rows[0].grain, "PRODUCT");
});

test("MATCH: identity-matched with no provable diffs → NOOP", () => {
  const res = buildShopifyPreview({ products: [product()], live: [liveProduct()], mappingByProductId: { p1: mapped() } });
  const r = res.rows[0];
  assert.equal(r.status, "MATCH");
  assert.deepEqual(r.changedFields, []);
  assert.deepEqual(r.plannedOps.map((o) => o.type), ["NOOP"]);
  assert.equal(r.shopifyProductGid, "gid://shopify/Product/1");
  assert.equal(res.counts.matched, 1);
});

test("UPDATE_REQUIRED: title + price diffs produce UPDATE_PRODUCT + UPDATE_PRICE", () => {
  const res = buildShopifyPreview({
    products: [product({ nameEn: "Serum Deluxe", discountPrice: 70 })],
    live: [liveProduct()],
    mappingByProductId: { p1: mapped() },
  });
  const r = res.rows[0];
  assert.equal(r.status, "UPDATE_REQUIRED");
  assert.ok(r.changedFields.includes("title") && r.changedFields.includes("price"));
  const ops = r.plannedOps.map((o) => o.type);
  assert.ok(ops.includes("UPDATE_PRODUCT") && ops.includes("UPDATE_PRICE"));
  assert.equal(res.counts.updateRequired, 1);
});

test("NEW: unmapped and SKU absent from the live store → CREATE_PRODUCT (no fabricated GID)", () => {
  const res = buildShopifyPreview({ products: [product({ sku: "FRESH" })], live: [liveProduct()] });
  const r = res.rows[0];
  assert.equal(r.status, "NEW");
  assert.equal(r.shopifyProductGid, null);
  assert.deepEqual(r.plannedOps.map((o) => o.type), ["CREATE_PRODUCT"]);
  assert.equal(res.counts.new, 1);
});

test("CONFLICT: needs_review mapping is a contested identity, never auto-resolved", () => {
  const res = buildShopifyPreview({
    products: [product()], live: [liveProduct()],
    mappingByProductId: { p1: { status: "needs_review", productGid: "gid://shopify/Product/1", variantGidByVariantId: {} } },
  });
  const r = res.rows[0];
  assert.equal(r.status, "CONFLICT");
  assert.ok(codes(r).includes("IDENTITY_NEEDS_REVIEW"));
  assert.equal(r.shopifyProductGid, null, "a contested GID is never surfaced as usable identity");
  assert.deepEqual(r.plannedOps.map((o) => o.type), ["BLOCKED"]);
});

test("CONFLICT: ECL GID absent from the live store cannot be proven", () => {
  const res = buildShopifyPreview({
    products: [product()], live: [liveProduct({ id: "gid://shopify/Product/999" })],
    mappingByProductId: { p1: mapped("gid://shopify/Product/1") },
  });
  assert.equal(res.rows[0].status, "CONFLICT");
  assert.ok(codes(res.rows[0]).includes("IDENTITY_CONFLICT"));
});

test("CONFLICT: unmapped product whose SKU already exists on Shopify is an unlinked duplicate (never NEW)", () => {
  const res = buildShopifyPreview({ products: [product({ sku: "SKU1" })], live: [liveProduct()] });
  assert.equal(res.rows[0].status, "CONFLICT");
  assert.ok(codes(res.rows[0]).includes("IDENTITY_CONFLICT"));
  assert.equal(res.counts.new, 0);
});

test("CONFLICT: one Shopify GID claimed by two internal products blocks both", () => {
  const res = buildShopifyPreview({
    products: [product({ id: "a", sku: "A", barcode: "6291041500001" }), product({ id: "b", sku: "B", barcode: "6291041500002" })],
    live: [liveProduct()],
    mappingByProductId: {
      a: mapped("gid://shopify/Product/1"),
      b: mapped("gid://shopify/Product/1"),
    },
  });
  assert.ok(res.rows.every((r) => r.status === "CONFLICT" && codes(r).includes("IDENTITY_CONFLICT")));
});

test("CONFLICT: one internal product mapped to conflicting GIDs (ECL disagreement)", () => {
  const res = buildShopifyPreview({
    products: [product()], live: [liveProduct()],
    mappingByProductId: { p1: { status: "active", productGid: "gid://shopify/Product/1", variantGidByVariantId: {}, hasConflictingProductGids: true } },
  });
  assert.equal(res.rows[0].status, "CONFLICT");
  assert.ok(codes(res.rows[0]).includes("IDENTITY_CONFLICT"));
});

test("BLOCKED: STOPPED lifecycle / missing title / missing image / duplicate SKU", () => {
  assert.equal(buildShopifyPreview({ products: [product({ lifecycleState: "STOPPED", platformStatus: "Stopped" })], live: [] }).rows[0].status, "BLOCKED");
  assert.equal(buildShopifyPreview({ products: [product({ nameEn: null, nameAr: null })], live: [] }).rows[0].status, "BLOCKED");
  assert.equal(buildShopifyPreview({ products: [product({ imageUrl: null, imageFilename: null, imageCount: 0 })], live: [] }).rows[0].status, "BLOCKED");
  const dup = buildShopifyPreview({ products: [product({ id: "a", sku: "DUP", barcode: "6291041500001" }), product({ id: "b", sku: "DUP", barcode: "6291041500002" })], live: [] });
  assert.ok(dup.rows.every((r) => r.status === "BLOCKED" && codes(r).includes("DUPLICATE_SKU")));
});

test("UNKNOWN: a null live store yields UNKNOWN rows and invents no diff", () => {
  const res = buildShopifyPreview({ products: [product()], live: null, mappingByProductId: { p1: mapped() } });
  const r = res.rows[0];
  assert.equal(res.shopifyAvailable, false);
  assert.equal(r.status, "UNKNOWN");
  assert.deepEqual(r.changedFields, []);
  assert.equal(r.shopifyProductGid, "gid://shopify/Product/1", "a mapped id is still surfaced, but nothing is diffed");
  assert.deepEqual(r.plannedOps.map((o) => o.type), ["BLOCKED"]);
  assert.equal(res.counts.unknown, 1);
  assert.equal(res.apiStats.shopifyProductsRead, 0);
});

test("no auto-publish: a status difference is surfaced but never actionable and never planned", () => {
  const res = buildShopifyPreview({
    products: [product({ lifecycleState: "active", platformStatus: "Active" })],
    live: [liveProduct({ status: "DRAFT" })],
    mappingByProductId: { p1: mapped() },
  });
  const r = res.rows[0];
  const statusDiff = r.fieldDiffs.find((f) => f.field === "status");
  assert.ok(statusDiff && statusDiff.changed && statusDiff.actionable === false, "status change is informational only");
  assert.equal(r.changedFields.includes("status"), false);
  assert.equal(r.status, "MATCH", "a status-only difference does not force an update");
  assert.equal(r.plannedOps.some((o) => /publish/i.test(o.type)), false);
});

test("description is actionable only when Shopify has none (HTML↔text equality is not reliable)", () => {
  // Shopify has a (differently-formatted) description → changed but NOT actionable.
  const soft = buildShopifyPreview({
    products: [product({ descriptionEn: "New copy." })],
    live: [liveProduct({ descriptionHtml: "<p>Old copy.</p>" })],
    mappingByProductId: { p1: mapped() },
  }).rows[0];
  const d1 = soft.fieldDiffs.find((f) => f.field === "description");
  assert.ok(d1 && d1.changed && d1.actionable === false);
  assert.equal(soft.changedFields.includes("description"), false);
  // Shopify has NO description → provable, actionable.
  const hard = buildShopifyPreview({
    products: [product({ descriptionEn: "Only ours." })],
    live: [liveProduct({ descriptionHtml: "" })],
    mappingByProductId: { p1: mapped() },
  }).rows[0];
  const d2 = hard.fieldDiffs.find((f) => f.field === "description");
  assert.ok(d2 && d2.actionable === true);
  assert.ok(hard.changedFields.includes("description"));
});

test("media: an actionable image diff appears only when Shopify is missing the image", () => {
  const res = buildShopifyPreview({
    products: [product()], live: [liveProduct({ imageUrl: "" })],
    mappingByProductId: { p1: mapped() },
  }).rows[0];
  assert.ok(res.changedFields.includes("image"));
  assert.ok(res.plannedOps.some((o) => o.type === "UPDATE_MEDIA"));
});

test("variant-aware: variant price diff aligns by SKU and plans UPDATE_PRICE at the variant", () => {
  const p = product({
    id: "vp", sku: null,
    variants: [
      { id: "v1", sku: "RED", barcode: "6291041500011", variantName: "Red", price: 55 },
      { id: "v2", sku: "BLUE", barcode: "6291041500012", variantName: "Blue", price: 60 },
    ],
    discountPrice: null,
  });
  const live = liveProduct({
    id: "gid://shopify/Product/7",
    variants: [
      { id: "gid://shopify/ProductVariant/71", sku: "RED", barcode: "6291041500011", price: "55.00", compareAtPrice: null, inventoryQuantity: 1 },
      { id: "gid://shopify/ProductVariant/72", sku: "BLUE", barcode: "6291041500012", price: "50.00", compareAtPrice: null, inventoryQuantity: 1 },
    ],
  });
  const res = buildShopifyPreview({ products: [p], live: [live], mappingByProductId: { vp: mapped("gid://shopify/Product/7") } }).rows[0];
  assert.equal(res.status, "UPDATE_REQUIRED");
  assert.equal(res.variantCount, 2);
  assert.equal(res.variantMatchedCount, 2);
  const priceOp = res.plannedOps.find((o) => o.type === "UPDATE_PRICE");
  assert.ok(priceOp && priceOp.variantGid === "gid://shopify/ProductVariant/72", "the changed variant is targeted by its GID");
  assert.ok(res.changedFields.includes("price"));
});

test("variant-aware: an internal variant missing on Shopify is surfaced (not hidden behind the parent)", () => {
  const p = product({
    id: "vp", sku: null,
    variants: [
      { id: "v1", sku: "RED", barcode: "6291041500011", variantName: "Red", price: 55 },
      { id: "v2", sku: "GREEN", barcode: "6291041500013", variantName: "Green", price: 55 },
    ],
    discountPrice: null,
  });
  const live = liveProduct({
    id: "gid://shopify/Product/7",
    variants: [{ id: "gid://shopify/ProductVariant/71", sku: "RED", barcode: "6291041500011", price: "55.00", compareAtPrice: null, inventoryQuantity: 1 }],
  });
  const res = buildShopifyPreview({ products: [p], live: [live], mappingByProductId: { vp: mapped("gid://shopify/Product/7") } }).rows[0];
  assert.equal(res.variantMatchedCount, 1);
  assert.ok(res.changedFields.includes("variantMissing"));
  assert.ok(res.plannedOps.some((o) => o.type === "UPDATE_PRODUCT" && o.fields.includes("variants")));
});

test("counts tally every class and the plan op totals", () => {
  const res = buildShopifyPreview({
    products: [
      product({ id: "m", sku: "M", barcode: "6291041500021" }),                    // MATCH
      product({ id: "u", sku: "U", barcode: "6291041500022", nameEn: "Changed" }), // UPDATE_REQUIRED
      product({ id: "n", sku: "N", barcode: "6291041500023" }),                    // NEW
    ],
    live: [
      liveProduct({ id: "gid://shopify/Product/M", variants: [{ id: "gid://shopify/ProductVariant/M1", sku: "M", barcode: "6291041500021", price: "80.00", compareAtPrice: "100.00", inventoryQuantity: 1 }] }),
      liveProduct({ id: "gid://shopify/Product/U", title: "Serum", variants: [{ id: "gid://shopify/ProductVariant/U1", sku: "U", barcode: "6291041500022", price: "80.00", compareAtPrice: "100.00", inventoryQuantity: 1 }] }),
    ],
    mappingByProductId: { m: mapped("gid://shopify/Product/M"), u: mapped("gid://shopify/Product/U") },
  });
  assert.equal(res.counts.total, 3);
  assert.equal(res.counts.matched, 1);
  assert.equal(res.counts.updateRequired, 1);
  assert.equal(res.counts.new, 1);
  assert.equal(res.counts.plannedOps.NOOP, 1);
  assert.equal(res.counts.plannedOps.CREATE_PRODUCT, 1);
  assert.ok(res.counts.plannedOps.UPDATE_PRODUCT >= 1);
});
