// Tests for the pure Shopify catalog diff.
// Run: node --experimental-strip-types --test lib/shopify-diff.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { diffShopify, targetShopifyPrice, normTitle, type OurProductRow, type ShopifyProductLite } from "./shopify-diff.ts";

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
