// Tests for the pure Shopify catalog diff.
// Run: node --experimental-strip-types --test lib/shopify-diff.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { diffShopify, targetShopifyPrice, normTitle, planInventorySync, htmlFromPlain, textFromHtml, shopifyToCatalogPrices, mapShopifyToCatalogRow, type OurProductRow, type ShopifyProductLite } from "./shopify-diff.ts";

const our = (over: Partial<OurProductRow>): OurProductRow => ({
  id: "p1", sku: null, name_en: "Rose Serum", name_ar: null, price: 100, discount_price: null, approval: "Approved", ...over,
});
const shop = (over: Partial<ShopifyProductLite>): ShopifyProductLite => ({
  id: "gid://shopify/Product/1", title: "Rose Serum", status: "ACTIVE",
  variants: [{ id: "gid://shopify/ProductVariant/11", sku: "", price: "100.00", compareAtPrice: null }],
  ...over,
});

test("discounted product maps to price=discount + compareAt=original", () => {
  assert.deepEqual(targetShopifyPrice(our({ price: 100, discount_price: 80 })), { price: "80.00", compareAtPrice: "100.00" });
  assert.deepEqual(targetShopifyPrice(our({ price: 100 })), { price: "100.00", compareAtPrice: null });
  assert.deepEqual(targetShopifyPrice(our({ price: 100, discount_price: 100 })), { price: "100.00", compareAtPrice: null });
});

test("matches by SKU first, then by normalized title", () => {
  const d = diffShopify(
    [our({ sku: "SKU-1", name_en: "Different Name" }), our({ id: "p2", name_en: "Gold – Mask" })],
    [
      shop({ variants: [{ id: "v1", sku: "sku-1", price: "100.00", compareAtPrice: null }], title: "Whatever" }),
      shop({ id: "gid://2", title: "Gold Mask", variants: [{ id: "v2", sku: "", price: "100.00", compareAtPrice: null }] }),
    ],
  );
  assert.equal(d.counts.matched, 2);
  assert.equal(d.counts.onlyOurs, 0);
  assert.equal(d.counts.onlyShopify, 0);
});

test("in-sync products produce no changes; price drift is flagged", () => {
  const clean = diffShopify([our({})], [shop({})]);
  assert.equal(clean.counts.updated, 0);
  assert.equal(clean.counts.unchanged, 1);

  const drift = diffShopify([our({ price: 120 })], [shop({})]);
  assert.equal(drift.counts.updated, 1);
  assert.deepEqual(drift.updated[0].changes.find((c) => c.field === "price"), { field: "price", old: "100.00", new: "120.00" });
});

test("approval drives status: Rejected catalog row on an ACTIVE store product", () => {
  const d = diffShopify([our({ approval: "Rejected" })], [shop({})]);
  const st = d.updated[0].changes.find((c) => c.field === "status");
  assert.deepEqual(st, { field: "status", old: "ACTIVE", new: "DRAFT" });
});

test("unmatched rows land in onlyOurs / onlyShopify", () => {
  const d = diffShopify(
    [our({ name_en: "Only Here" })],
    [shop({ title: "Only There" })],
  );
  assert.equal(d.counts.onlyOurs, 1);
  assert.equal(d.counts.onlyShopify, 1);
  assert.equal(d.onlyOurs[0].name_en, "Only Here");
  assert.equal(d.onlyShopify[0].title, "Only There");
});

test("normTitle flattens punctuation, case and unicode variants", () => {
  assert.equal(normTitle("Women’s  Watch – GOLD"), normTitle("womens watch gold"));
});

test("inventory plan corrects drifted quantities and skips in-sync/unmatched", () => {
  const shopify: ShopifyProductLite[] = [
    shop({ variants: [{ id: "v1", sku: "sku-1", price: "10", compareAtPrice: null, inventoryItemId: "inv1", inventoryQuantity: 5 }], title: "A" }),
    shop({ id: "gid://2", title: "B Product", variants: [{ id: "v2", sku: "", price: "10", compareAtPrice: null, inventoryItemId: "inv2", inventoryQuantity: 7 }] }),
  ];
  const plan = planInventorySync(
    [
      { id: "p1", sku: "SKU-1", name_en: "x", stock: 12 },        // drift 5→12
      { id: "p2", sku: null, name_en: "B – Product", stock: 7 },  // in sync
      { id: "p3", sku: null, name_en: "Nowhere", stock: 3 },      // unmatched
    ],
    shopify,
  );
  assert.equal(plan.matched, 2);
  assert.equal(plan.unmatched, 1);
  assert.deepEqual(plan.changes, [{ product_id: "p1", name_en: "x", inventoryItemId: "inv1", from: 5, quantity: 12 }]);
});

test("inventory plan clamps negative stock to zero", () => {
  const shopify: ShopifyProductLite[] = [
    shop({ variants: [{ id: "v1", sku: "s", price: "10", compareAtPrice: null, inventoryItemId: "inv1", inventoryQuantity: 4 }] }),
  ];
  const plan = planInventorySync([{ id: "p1", sku: "s", name_en: "x", stock: -3 }], shopify);
  assert.equal(plan.changes[0].quantity, 0);
});

test("htmlFromPlain escapes and keeps line breaks", () => {
  assert.equal(htmlFromPlain("a<b\nc & d"), "a&lt;b<br>c &amp; d");
  assert.equal(htmlFromPlain(null), "");
});

test("textFromHtml strips tags/entities and preserves breaks", () => {
  assert.equal(textFromHtml("<p>Hello <b>world</b></p><br>&amp; more&nbsp;!"), "Hello world\n\n& more !");
  assert.equal(textFromHtml(""), "");
});

test("shopifyToCatalogPrices inverts the discount mapping", () => {
  assert.deepEqual(shopifyToCatalogPrices("80.00", "100.00"), { price: 100, discount_price: 80 });
  assert.deepEqual(shopifyToCatalogPrices("100.00", null), { price: 100, discount_price: null });
  assert.deepEqual(shopifyToCatalogPrices("100.00", "90.00"), { price: 100, discount_price: null }); // compareAt below price = noise
  assert.deepEqual(shopifyToCatalogPrices("", null), { price: null, discount_price: null });
});

test("mapShopifyToCatalogRow builds a complete catalog insert", () => {
  const row = mapShopifyToCatalogRow(shop({
    title: "  Glow Serum  ",
    status: "ACTIVE",
    descriptionHtml: "<p>Nice<br>serum</p>",
    imageUrl: "https://cdn/img.jpg",
    variants: [{ id: "v", sku: "GS-1", price: "80.00", compareAtPrice: "100.00" }],
  }));
  assert.deepEqual(row, {
    name_en: "Glow Serum", description_en: "Nice\nserum",
    price: 100, discount_price: 80, sku: "GS-1",
    image_url: "https://cdn/img.jpg", approval: "Approved",
  });
  assert.equal(mapShopifyToCatalogRow(shop({ status: "DRAFT" })).approval, "Rejected");
});
