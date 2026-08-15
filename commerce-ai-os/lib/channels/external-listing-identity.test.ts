// CH.5 — identity model: uniqueness keys + health classification.
// node --conditions=react-server --experimental-strip-types --test lib/channels/external-listing-identity.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  type ExternalListingRecord,
  internalUniquenessKey, externalIdentityKey, skuIdentityKey,
  identityTypeMatchesStorefront, classifyListingHealth,
} from "./external-listing-identity.ts";

function rec(o: Partial<ExternalListingRecord>): ExternalListingRecord {
  return {
    productId: "p1", variantId: null, variantSku: null,
    channelKey: "snoonu", storefrontKey: "snoonu:malikas",
    externalProductId: null, externalVariantId: null, exportedSku: null, exportedBarcode: null,
    identityType: "snoonu_spi", mappingStatus: "active", ...o,
  };
}

test("external identity is STOREFRONT-scoped — two Snoonu stores never collide", () => {
  const a = externalIdentityKey(rec({ storefrontKey: "snoonu:malikas", externalProductId: "SPI-A" }));
  const b = externalIdentityKey(rec({ storefrontKey: "snoonu:pure_seoul", externalProductId: "SPI-B" }));
  assert.notEqual(a, b);
  // Even the SAME SPI value in different stores is a different identity.
  const c = externalIdentityKey(rec({ storefrontKey: "snoonu:malikas", externalProductId: "SPI-X" }));
  const d = externalIdentityKey(rec({ storefrontKey: "snoonu:pure_seoul", externalProductId: "SPI-X" }));
  assert.notEqual(c, d);
});

test("internal uniqueness allows Shopify product row + variant rows; distinguishes Talabat variants", () => {
  const prod = internalUniquenessKey(rec({ storefrontKey: "shopify:malikas", variantId: null, variantSku: null }));
  const varr = internalUniquenessKey(rec({ storefrontKey: "shopify:malikas", variantId: "v1", variantSku: null }));
  assert.notEqual(prod, varr);
  const tA = internalUniquenessKey(rec({ storefrontKey: "talabat:malikas", variantId: null, variantSku: "MK-1-A" }));
  const tB = internalUniquenessKey(rec({ storefrontKey: "talabat:malikas", variantId: null, variantSku: "MK-1-B" }));
  assert.notEqual(tA, tB); // flattened variants stay distinct
});

test("sku identity key is storefront-scoped + case-insensitive; null without a sku", () => {
  assert.equal(skuIdentityKey(rec({ storefrontKey: "talabat:malikas", exportedSku: "MK-9" })), "talabat:malikas::mk-9");
  assert.equal(skuIdentityKey(rec({ exportedSku: null })), null);
});

test("externalIdentityKey is null when there is no durable external handle", () => {
  assert.equal(externalIdentityKey(rec({ externalProductId: null, externalVariantId: null })), null);
});

test("identityType must match the storefront's declared type", () => {
  assert.equal(identityTypeMatchesStorefront("talabat:malikas", "talabat_sku"), true);
  assert.equal(identityTypeMatchesStorefront("talabat:malikas", "snoonu_spi"), false);
});

test("health: HEALTHY / UNMAPPED / AMBIGUOUS / ORPHANED / STALE / NEEDS_REVIEW", () => {
  assert.equal(classifyListingHealth(rec({ externalProductId: "SPI-A" }), { productExists: true }), "HEALTHY");
  assert.equal(classifyListingHealth(rec({}), { productExists: true }), "UNMAPPED"); // no external handle
  assert.equal(classifyListingHealth(rec({ externalProductId: "SPI-A" }), { productExists: true, internalTargetsForExternalId: 2 }), "AMBIGUOUS");
  assert.equal(classifyListingHealth(rec({ externalProductId: "SPI-A" }), { productExists: false }), "ORPHANED");
  assert.equal(
    classifyListingHealth(rec({ storefrontKey: "talabat:malikas", identityType: "talabat_sku", exportedSku: "MK-1-A", variantSku: "MK-1-A" }),
      { productExists: true, variantExists: true, currentVariantSku: "MK-1-Z" }),
    "STALE",
  );
  assert.equal(classifyListingHealth(rec({ externalProductId: "SPI-A", mappingStatus: "needs_review" }), { productExists: true }), "NEEDS_REVIEW");
});

test("storefront isolation: healthy in one store does not imply mapped in another", () => {
  // Only a snoonu:malikas record exists; pure_seoul has none → the pure_seoul
  // projection is UNMAPPED (proven at the resolver level; here we assert the
  // record set carries the storefront so the two are independent).
  const m = rec({ storefrontKey: "snoonu:malikas", externalProductId: "SPI-A" });
  assert.equal(m.storefrontKey, "snoonu:malikas");
  assert.notEqual(externalIdentityKey(m), externalIdentityKey(rec({ storefrontKey: "snoonu:pure_seoul", externalProductId: "SPI-A" })));
});
