// SHOPIFY.PRICE.1 tests — the ONE canonical pricing rule + compare-at
// hardening, at helper level AND through the certified preview planner.
// Run: node --conditions=react-server --experimental-strip-types --test lib/export/shopify/pricing.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { canonicalUnitPricing, normalizeCompareAt } from "./pricing.ts";
import { buildShopifyPreview, type ShopifyInternalProduct, type ShopifyLiveProduct } from "./preview.ts";
import { effectiveVariantPrice } from "./variant-repair.ts";

// ── helper-level: the canonical rule ─────────────────────────────────────────

test("case 1: explicit child price == parent price, parent discount populated → sell child, compareAt null", () => {
  for (const [vp, pp, disc] of [[84.25, 84.25, 25.25], [110, 110, 33], [560, 560, 168]] as const) {
    const r = canonicalUnitPricing(vp, disc, pp);
    assert.equal(r.sellPrice, vp, "sell price is the child's explicit price");
    assert.equal(r.compareAtPrice, null, "compareAt == sell is meaningless → null");
  }
});

test("case 2: explicit child price differs from parent price, discount populated → child wins; compareAt only when parent > child", () => {
  const below = canonicalUnitPricing(50, 25.25, 84.25);
  assert.equal(below.sellPrice, 50);
  assert.equal(below.compareAtPrice, 84.25, "parent price 84.25 > child 50 → a real sale relationship");

  const above = canonicalUnitPricing(90, 25.25, 84.25);
  assert.equal(above.sellPrice, 90);
  assert.equal(above.compareAtPrice, null, "parent price below the child's sell price → null");
});

test("case 3: child price null, parent discount < parent price → sell discount, compareAt parent price", () => {
  const r = canonicalUnitPricing(null, 80, 100);
  assert.equal(r.sellPrice, 80);
  assert.equal(r.compareAtPrice, 100);
});

test("case 4: child price null, no discount → sell parent price, compareAt null", () => {
  const r = canonicalUnitPricing(null, null, 239);
  assert.equal(r.sellPrice, 239);
  assert.equal(r.compareAtPrice, null);
});

test("case 5: compareAt == sell price → normalized to null", () => {
  assert.equal(normalizeCompareAt(84.25, 84.25), null);
  assert.equal(normalizeCompareAt(84.25, 84.251), null, "within money epsilon counts as equal");
});

test("case 6: compareAt < sell price → normalized to null", () => {
  assert.equal(normalizeCompareAt(90, 84.25), null);
  const r = canonicalUnitPricing(null, 100, 80); // discount ABOVE parent price
  assert.equal(r.sellPrice, 100);
  assert.equal(r.compareAtPrice, null, "parent price 80 below sell 100 → never written");
});

test("case 7: compareAt > sell price → preserved", () => {
  assert.equal(normalizeCompareAt(80, 100), 100);
  assert.equal(canonicalUnitPricing(null, 80, 100).compareAtPrice, 100);
});

test("sell precedence unchanged: variant ?? parent discount ?? parent price (positive only)", () => {
  assert.equal(canonicalUnitPricing(15, 99, 18).sellPrice, 15);
  assert.equal(canonicalUnitPricing(null, 99, 18).sellPrice, 99);
  assert.equal(canonicalUnitPricing(0, null, 18).sellPrice, 18, "zero is not a price");
  assert.equal(canonicalUnitPricing(null, null, 0).sellPrice, null);
});

test("variant-repair effectiveVariantPrice delegates to the same canonical rule", () => {
  const p = { id: "p", sku: "mk", price: 239, discountPrice: null, variants: [] };
  assert.equal(effectiveVariantPrice({ id: "v", name: "A", sku: "s", barcode: "b", price: null }, p), 239);
  assert.equal(effectiveVariantPrice({ id: "v", name: "A", sku: "s", barcode: "b", price: 15 }, p), 15);
  assert.equal(
    effectiveVariantPrice({ id: "v", name: "A", sku: "s", barcode: "b", price: null }, { ...p, discountPrice: 199 }),
    199,
  );
});

// ── planner-level: no degenerate compareAt-only UPDATE_PRICE ─────────────────

// The 9 real production products whose parent discount previously produced
// compareAt == sell UPDATE_PRICE plans (fresh audit values).
const KNOWN_NINE: readonly [string, number, number, number, number][] = [
  // [sku, parentPrice, discount, variantPrice, variantCount]
  ["mk1157", 84.25, 25.25, 84.25, 3],
  ["mk1158", 110, 33, 110, 5],
  ["mk1191", 560, 168, 560, 3],
  ["mk1192", 560, 168, 560, 3],
  ["mk1193", 560, 168, 560, 3],
  ["mk1194", 676, 202.75, 676, 3],
  ["mk965", 128, 12.75, 128, 5],
  ["mk966", 128, 12.75, 128, 4],
  ["mk967", 128, 12.75, 128, 4],
];

function fixture(sku: string, parentPrice: number, discount: number | null, variantPrice: number | null, count: number) {
  const pid = `p-${sku}`;
  const gid = `gid://shopify/Product/${sku}`;
  const product: ShopifyInternalProduct = {
    id: pid, sku, barcode: null, nameEn: `T-${sku}`, nameAr: "x",
    descriptionEn: "x", descriptionAr: "x", price: parentPrice, discountPrice: discount,
    imageUrl: "https://x.local/i.jpg", imageFilename: "i.jpg", imageCount: 1,
    variants: Array.from({ length: count }, (_, i) => ({
      id: `${pid}-v${i}`, sku: `${sku}-${i + 1}`, barcode: `${sku}-bc-${i + 1}`, variantName: `N${i + 1}`, price: variantPrice,
    })),
  };
  const livePrice = variantPrice ?? (discount ?? parentPrice);
  const live: ShopifyLiveProduct = {
    id: gid, title: `T-${sku}`, status: "DRAFT", descriptionHtml: "<p>x</p>", imageUrl: "https://x.local/i.jpg",
    variants: Array.from({ length: count }, (_, i) => ({
      id: `gid://shopify/ProductVariant/${sku}-${i}`, sku: `${sku}-${i + 1}`, barcode: `${sku}-bc-${i + 1}`,
      price: livePrice.toFixed(2), compareAtPrice: null, inventoryQuantity: 0,
    })),
  };
  const mapping = {
    [pid]: {
      status: "active" as const, productGid: gid,
      variantGidByVariantId: Object.fromEntries(product.variants!.map((v, i) => [v.id, `gid://shopify/ProductVariant/${sku}-${i}`])),
    },
  };
  return { product, live, mapping };
}

test("case 1+8: the known 9 products no longer plan UPDATE_PRICE for a degenerate compareAt", () => {
  for (const [sku, pp, disc, vp, n] of KNOWN_NINE) {
    const f = fixture(sku, pp, disc, vp, n);
    const r = buildShopifyPreview({ products: [f.product], live: [f.live], mappingByProductId: f.mapping });
    const row = r.rows[0]!;
    const priceOps = row.plannedOps.filter((o) => o.type === "UPDATE_PRICE");
    assert.deepEqual(priceOps, [], `${sku}: no compareAt-only UPDATE_PRICE`);
    assert.equal(row.status, "MATCH", `${sku}: converged product stays MATCH`);
    assert.deepEqual(row.plannedOps.map((o) => o.type), ["NOOP"]);
  }
});

test("real sale on a variant (parent price > explicit child price) still plans compareAt", () => {
  const f = fixture("mkSALE", 84.25, 25.25, 50, 2); // child 50, parent 84.25 → compareAt 84.25 desired
  const r = buildShopifyPreview({ products: [f.product], live: [f.live], mappingByProductId: f.mapping });
  const priceOps = r.rows[0]!.plannedOps.filter((o) => o.type === "UPDATE_PRICE");
  assert.equal(priceOps.length, 2, "one per variant");
  for (const op of priceOps) assert.deepEqual(op.fields, ["compareAt"], "live compareAt null → plans the REAL sale compare-at");
});

test("inherited sale (child price null, discount < price) plans price+compareAt toward the sale values", () => {
  const f = fixture("mkINH", 100, 80, null, 2);
  // live currently at the FULL parent price with no compareAt
  f.live.variants = f.live.variants.map((v) => ({ ...v, price: "100.00" }));
  const r = buildShopifyPreview({ products: [f.product], live: [f.live], mappingByProductId: f.mapping });
  const priceOps = r.rows[0]!.plannedOps.filter((o) => o.type === "UPDATE_PRICE");
  assert.equal(priceOps.length, 2);
  for (const op of priceOps) assert.deepEqual([...op.fields].sort(), ["compareAt", "price"], "sell 80 + compareAt 100");
});
