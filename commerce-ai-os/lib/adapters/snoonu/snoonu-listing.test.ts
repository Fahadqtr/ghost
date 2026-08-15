// CH.6A — Snoonu listing projection tests.
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/snoonu-listing.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { projectSnoonuListing, snoonuListingHealth } from "./snoonu-listing.ts";

const product = { id: "p1", sku: "MK-1", barcode: "29001", name_en: "Cream", name_ar: "كريم", price: "42" };

test("projects catalog fields + storefront-scoped SPI, explicit availability, no quantity", () => {
  const l = projectSnoonuListing({ storefrontKey: "snoonu:malikas", product, spi: "SPI-A", mappingStatus: "active", availability: "in_stock" });
  assert.equal(l.storefrontKey, "snoonu:malikas");
  assert.equal(l.spi, "SPI-A");
  assert.equal(l.identityType, "snoonu_spi");
  assert.equal(l.price, 42);
  assert.equal(l.availability, "in_stock");
  assert.equal(l.health, "HEALTHY");
  assert.ok(!Object.keys(l).some((k) => /stock|quantity|qty/i.test(k)), "listing owns no quantity");
});

test("same product, two storefronts, DIFFERENT SPIs — independent listings", () => {
  const mal = projectSnoonuListing({ storefrontKey: "snoonu:malikas", product, spi: "SPI-A", mappingStatus: "active" });
  const ps = projectSnoonuListing({ storefrontKey: "snoonu:pure_seoul", product, spi: "SPI-B", mappingStatus: "active" });
  assert.notEqual(mal.spi, ps.spi);
  assert.equal(mal.health, "HEALTHY");
  assert.equal(ps.health, "HEALTHY");
});

test("storefront isolation: mapped in Malikas, UNMAPPED in Pure Seoul", () => {
  const mal = projectSnoonuListing({ storefrontKey: "snoonu:malikas", product, spi: "SPI-A", mappingStatus: "active" });
  const ps = projectSnoonuListing({ storefrontKey: "snoonu:pure_seoul", product, spi: null });
  assert.equal(mal.health, "HEALTHY");
  assert.equal(ps.health, "UNMAPPED"); // one storefront never satisfies the other
});

test("availability defaults to unknown and is never inferred from quantity", () => {
  const l = projectSnoonuListing({ storefrontKey: "snoonu:malikas", product, spi: "SPI-A", mappingStatus: "active" });
  assert.equal(l.availability, "unknown");
});

test("health states", () => {
  assert.equal(snoonuListingHealth("SPI", "active", true), "HEALTHY");
  assert.equal(snoonuListingHealth(null, "active", true), "UNMAPPED");
  assert.equal(snoonuListingHealth("SPI", "needs_review", true), "NEEDS_REVIEW");
  assert.equal(snoonuListingHealth("SPI", "active", false), "ORPHANED");
});
