// CH.5 — durable resolver round-trip tests (fake port; no DB).
// node --conditions=react-server --experimental-strip-types --test lib/channels/durable-identity-resolver.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { createDurableIdentityResolver, type ExternalListingReaderPort } from "./durable-identity-resolver.ts";
import { type ExternalListingRecord } from "./external-listing-identity.ts";
import { type StoreRef } from "../adapters/types.ts";

function rec(o: Partial<ExternalListingRecord>): ExternalListingRecord {
  return {
    productId: "p1", variantId: null, variantSku: null,
    channelKey: "snoonu", storefrontKey: "snoonu:malikas",
    externalProductId: null, externalVariantId: null, exportedSku: null, exportedBarcode: null,
    identityType: "snoonu_spi", mappingStatus: "active", ...o,
  };
}

const s = (v: string | null | undefined) => (v ?? "").trim();

function fakePort(records: ExternalListingRecord[]): ExternalListingReaderPort {
  return {
    byProduct: async (pid) => records.filter((r) => r.productId === pid),
    byExternalId: async (storefront, extPid, extVid) =>
      records.filter((r) => r.storefrontKey === storefront && (extPid ? r.externalProductId === extPid : true) && (extVid ? r.externalVariantId === extVid : true)),
    bySku: async (storefront, sku) =>
      records.filter((r) => r.storefrontKey === storefront && s(r.exportedSku).toLowerCase() === s(sku).toLowerCase()),
  };
}

// One product, five storefronts (the §1 example).
const DB: ExternalListingRecord[] = [
  rec({ storefrontKey: "snoonu:malikas", channelKey: "snoonu", externalProductId: "SPI-A", identityType: "snoonu_spi" }),
  rec({ storefrontKey: "snoonu:pure_seoul", channelKey: "snoonu", externalProductId: "SPI-B", identityType: "snoonu_spi" }),
  rec({ storefrontKey: "rafeeq:malikas", channelKey: "rafeeq", externalProductId: "RF-C", identityType: "rafeeq_product_id" }),
  rec({ storefrontKey: "shopify:malikas", channelKey: "shopify", externalProductId: "gid://Product/D", externalVariantId: "gid://Variant/D1", variantId: "v-d1", identityType: "shopify_gid" }),
  rec({ storefrontKey: "talabat:malikas", channelKey: "talabat", variantSku: "MK-1-A", exportedSku: "MK-1-A", identityType: "talabat_sku" }),
  rec({ storefrontKey: "talabat:malikas", channelKey: "talabat", variantSku: "MK-1-B", exportedSku: "MK-1-B", identityType: "talabat_sku" }),
];

test("one product resolves to a DIFFERENT external identity per storefront", async () => {
  const r = createDurableIdentityResolver(fakePort(DB));
  const mal = await r.resolveExternalListing({ productId: "p1", channel: "snoonu", storefront: "snoonu:malikas" });
  const ps = await r.resolveExternalListing({ productId: "p1", channel: "snoonu", storefront: "snoonu:pure_seoul" });
  assert.equal(mal.listing!.externalProductId, "SPI-A");
  assert.equal(ps.listing!.externalProductId, "SPI-B");
  assert.equal(mal.health, "HEALTHY");
  assert.equal(ps.health, "HEALTHY");
});

test("storefront isolation: mapped in Malikas, UNMAPPED in a store with no row", async () => {
  const onlyMalikas = [rec({ storefrontKey: "snoonu:malikas", externalProductId: "SPI-A" })];
  const r = createDurableIdentityResolver(fakePort(onlyMalikas));
  const ps = await r.resolveExternalListing({ productId: "p1", channel: "snoonu", storefront: "snoonu:pure_seoul" });
  assert.equal(ps.status, "unmapped");
  assert.equal(ps.health, "UNMAPPED");
  assert.equal(ps.listing, null);
});

test("Shopify product + variant GIDs round trip", async () => {
  const r = createDurableIdentityResolver(fakePort(DB));
  const back = await r.resolveInternalListing({ channel: "shopify", storefront: "shopify:malikas", externalProductId: "gid://Product/D", externalVariantId: "gid://Variant/D1" });
  assert.equal(back.status, "resolved");
  assert.equal(back.productId, "p1");
  assert.equal(back.variantId, "v-d1");
});

test("Rafeeq product id resolves internally", async () => {
  const r = createDurableIdentityResolver(fakePort(DB));
  const back = await r.resolveInternalListing({ channel: "rafeeq", storefront: "rafeeq:malikas", externalProductId: "RF-C" });
  assert.equal(back.productId, "p1");
});

test("Talabat flattened variant maps back to the EXACT internal variant via SKU", async () => {
  const r = createDurableIdentityResolver(fakePort(DB));
  const a = await r.resolveInternalListing({ channel: "talabat", storefront: "talabat:malikas", sku: "MK-1-A" });
  const b = await r.resolveInternalListing({ channel: "talabat", storefront: "talabat:malikas", sku: "MK-1-B" });
  assert.equal(a.variantSku, "MK-1-A");
  assert.equal(b.variantSku, "MK-1-B");
  assert.equal(a.status, "resolved");
});

test("duplicate external identity resolves as AMBIGUOUS (never a silent pick)", async () => {
  const dup = [
    rec({ productId: "p1", storefrontKey: "snoonu:malikas", externalProductId: "DUP" }),
    rec({ productId: "p2", storefrontKey: "snoonu:malikas", externalProductId: "DUP" }),
  ];
  const r = createDurableIdentityResolver(fakePort(dup));
  const back = await r.resolveInternalListing({ channel: "snoonu", storefront: "snoonu:malikas", externalProductId: "DUP" });
  assert.equal(back.status, "ambiguous");
  assert.equal(back.health, "AMBIGUOUS");
  assert.equal(back.productId, null);
});

test("full round trip: internal → external → internal is stable", async () => {
  const r = createDurableIdentityResolver(fakePort(DB));
  const ext = await r.resolveExternalListing({ productId: "p1", channel: "rafeeq", storefront: "rafeeq:malikas" });
  const back = await r.resolveInternalListing({ channel: "rafeeq", storefront: "rafeeq:malikas", externalProductId: ext.listing!.externalProductId });
  assert.equal(back.productId, "p1");
});

test("no fuzzy fallback: an internal query with neither id nor sku is UNMAPPED", async () => {
  const r = createDurableIdentityResolver(fakePort(DB));
  const back = await r.resolveInternalListing({ channel: "snoonu", storefront: "snoonu:malikas", barcode: "29001" });
  assert.equal(back.status, "unmapped"); // barcode alone is not a durable resolver key
});

test("CH.4 compat resolve() returns an ExternalListingRef with provenance source", async () => {
  const r = createDurableIdentityResolver(fakePort(DB));
  const store: StoreRef = { channel: "snoonu", storeId: "snoonu:malikas", storeKey: "snoonu:malikas", label: "x", listingGrain: "product" };
  const ref = await r.resolve(store, { productId: "p1" });
  assert.equal(ref.externalListingId, "SPI-A");
  assert.equal(ref.source, "products_column"); // snoonu_spi → products_column (CH.4 vocab)
});

test("resolutions carry identity + health ONLY — never quantity/stock", async () => {
  const r = createDurableIdentityResolver(fakePort(DB));
  const res = await r.resolveExternalListing({ productId: "p1", channel: "snoonu", storefront: "snoonu:malikas" });
  const keys = Object.keys(res.listing ?? {});
  assert.ok(!keys.some((k) => /stock|quantity|qty|inventory/i.test(k)), "no quantity fields on a listing");
  assert.ok(!Object.keys(res).some((k) => /stock|quantity|qty|inventory/i.test(k)));
});
