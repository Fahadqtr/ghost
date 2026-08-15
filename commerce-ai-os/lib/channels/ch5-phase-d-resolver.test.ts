// CH.5 Phase D — durable resolver contract, seeded with REAL production sample
// rows (pulled read-only during the Phase D dual-read verification). Proves
// storefront isolation and that Rafeeq duplicate-id conflicts surface as
// NEEDS_REVIEW in BOTH directions, never silently picking a product.
//
// node --conditions=react-server --experimental-strip-types --test lib/channels/ch5-phase-d-resolver.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { createDurableIdentityResolver, type ExternalListingReaderPort } from "./durable-identity-resolver.ts";
import { type ExternalListingRecord } from "./external-listing-identity.ts";

function rec(o: Partial<ExternalListingRecord>): ExternalListingRecord {
  return {
    productId: "", variantId: null, variantSku: null, channelKey: "snoonu",
    storefrontKey: "", externalProductId: null, externalVariantId: null,
    exportedSku: null, exportedBarcode: null, identityType: "snoonu_spi",
    mappingStatus: "active", ...o,
  };
}

// Real production sample (project vqstcmattiarhblqshvb).
const DB: ExternalListingRecord[] = [
  rec({ productId: "0001f445", storefrontKey: "snoonu:malikas",    externalProductId: "69bc5e8a52169cc4e5ddc41b" }),
  rec({ productId: "0001f445", storefrontKey: "snoonu:pure_seoul", externalProductId: "69bc5f7df0683334a80ae2bd" }),
  rec({ productId: "0001f445", storefrontKey: "rafeeq:malikas",    externalProductId: "mk1156", channelKey: "rafeeq", identityType: "rafeeq_product_id" }),
  rec({ productId: "002cf3ad", storefrontKey: "snoonu:malikas",    externalProductId: "6a511887484a4a0f4bbc0599" }),
  rec({ productId: "002cf3ad", storefrontKey: "snoonu:pure_seoul", externalProductId: "6a511bf2f60bba709790e46e" }),
  // Rafeeq duplicate-id conflicts (needs_review; contested id in metadata, NULL unique column)
  rec({ productId: "2b830af9", storefrontKey: "rafeeq:malikas", channelKey: "rafeeq", identityType: "rafeeq_product_id", mappingStatus: "needs_review", metadata: { claimed_external_product_id: "695342530" } }),
  rec({ productId: "6a3a6ed6", storefrontKey: "rafeeq:malikas", channelKey: "rafeeq", identityType: "rafeeq_product_id", mappingStatus: "needs_review", metadata: { claimed_external_product_id: "695342530" } }),
  rec({ productId: "d17fac72", storefrontKey: "rafeeq:malikas", channelKey: "rafeeq", identityType: "rafeeq_product_id", mappingStatus: "needs_review", metadata: { claimed_external_product_id: "691712302" } }),
  rec({ productId: "eb43af13", storefrontKey: "rafeeq:malikas", channelKey: "rafeeq", identityType: "rafeeq_product_id", mappingStatus: "needs_review", metadata: { claimed_external_product_id: "691712302" } }),
];

const port: ExternalListingReaderPort = {
  byProduct: async (pid) => DB.filter((r) => r.productId === pid),
  byExternalId: async (sf, ext) => DB.filter((r) => r.storefrontKey === sf && ext != null && r.externalProductId === ext),
  bySku: async (sf, sku) => DB.filter((r) => r.storefrontKey === sf && r.exportedSku === sku),
  byClaimedExternalId: async (sf, id) =>
    DB.filter((r) => r.storefrontKey === sf && r.mappingStatus === "needs_review" && (r.metadata?.claimed_external_product_id as string) === id),
};

test("storefront isolation: one product, different SPI per Snoonu store", async () => {
  const r = createDurableIdentityResolver(port);
  const mal = await r.resolveExternalListing({ productId: "0001f445", channel: "snoonu", storefront: "snoonu:malikas" });
  const ps = await r.resolveExternalListing({ productId: "0001f445", channel: "snoonu", storefront: "snoonu:pure_seoul" });
  assert.equal(mal.listing!.externalProductId, "69bc5e8a52169cc4e5ddc41b");
  assert.equal(ps.listing!.externalProductId, "69bc5f7df0683334a80ae2bd");
  assert.notEqual(mal.listing!.externalProductId, ps.listing!.externalProductId);
  assert.equal(mal.health, "HEALTHY");
});

test("no cross-store leakage: a Malikas SPI does not resolve in the Pure Seoul store", async () => {
  const r = createDurableIdentityResolver(port);
  const wrong = await r.resolveInternalListing({ channel: "snoonu", storefront: "snoonu:pure_seoul", externalProductId: "69bc5e8a52169cc4e5ddc41b" });
  assert.equal(wrong.status, "unmapped");
  assert.equal(wrong.productId, null);
  const right = await r.resolveInternalListing({ channel: "snoonu", storefront: "snoonu:malikas", externalProductId: "69bc5e8a52169cc4e5ddc41b" });
  assert.equal(right.productId, "0001f445"); // round trip in the correct store
});

test("Rafeeq conflict (forward): resolving the conflict product yields NEEDS_REVIEW", async () => {
  const r = createDurableIdentityResolver(port);
  const res = await r.resolveExternalListing({ productId: "2b830af9", channel: "rafeeq", storefront: "rafeeq:malikas" });
  assert.equal(res.status, "needs_review");
  assert.equal(res.health, "NEEDS_REVIEW");
});

test("Rafeeq conflict (reverse): looking up the contested id yields NEEDS_REVIEW, never a product", async () => {
  const r = createDurableIdentityResolver(port);
  const res = await r.resolveInternalListing({ channel: "rafeeq", storefront: "rafeeq:malikas", externalProductId: "695342530" });
  assert.equal(res.status, "needs_review");
  assert.equal(res.health, "NEEDS_REVIEW");
  assert.equal(res.productId, null); // never silently picks mk898 or mk900
});

test("clean Rafeeq id still round-trips normally", async () => {
  const r = createDurableIdentityResolver(port);
  const back = await r.resolveInternalListing({ channel: "rafeeq", storefront: "rafeeq:malikas", externalProductId: "mk1156" });
  assert.equal(back.productId, "0001f445");
});
