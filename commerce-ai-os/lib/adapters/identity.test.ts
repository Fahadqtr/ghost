// CH.4 — external identity resolver (CH.2-backed) tests.
// node --conditions=react-server --experimental-strip-types --test lib/adapters/identity.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { createProjectionIdentityResolver, type ProjectionRead } from "./identity.ts";
import { type StoreRef } from "./types.ts";
import { type ProductChannelProjection } from "../channels/channel-model.ts";

const store = (channel: StoreRef["channel"], key: string): StoreRef => ({
  channel, storeId: key, storeKey: key, label: key, listingGrain: "product",
});

function proj(channel: ProductChannelProjection["channel"], externalId: string | null, source: ProductChannelProjection["externalIdSource"]): ProductChannelProjection {
  return {
    productId: "p1", channel, label: channel, availabilityMode: "binary",
    externalId, externalIdSource: source, mappingPresent: externalId != null,
    listingStatus: null, listingSource: "none", approval: null, availability: null,
    availabilitySource: "none", channelPrice: null, priceSource: "internal_base",
  };
}

test("resolves the external id for the store's channel", async () => {
  const read: ProjectionRead = {
    degraded: false,
    projections: [proj("snoonu", "SN-123", "products_column"), proj("shopify", null, "live_match")],
  };
  const resolver = createProjectionIdentityResolver(async () => read);
  const ref = await resolver.resolve(store("snoonu", "snoonu:malikas"), { productId: "p1" });
  assert.equal(ref.externalListingId, "SN-123");
  assert.equal(ref.source, "products_column");
  assert.equal(ref.storeKey, "snoonu:malikas");
});

test("Shopify live-match resolves to a null id with source live_match", async () => {
  const resolver = createProjectionIdentityResolver(async () => ({
    degraded: false, projections: [proj("shopify", null, "live_match")],
  }));
  const ref = await resolver.resolve(store("shopify", "shopify:main"), { productId: "p1" });
  assert.equal(ref.externalListingId, null);
  assert.equal(ref.source, "live_match");
});

test("degraded read → null id, source none (never invents a mapping)", async () => {
  const resolver = createProjectionIdentityResolver(async () => ({ degraded: true, projections: [] }));
  const ref = await resolver.resolve(store("snoonu", "s"), { productId: "p1" });
  assert.equal(ref.externalListingId, null);
  assert.equal(ref.source, "none");
});

test("loader throw is contained → null id, source none", async () => {
  const resolver = createProjectionIdentityResolver(async () => { throw new Error("db down"); });
  const ref = await resolver.resolve(store("rafeeq", "r"), { productId: "p1" });
  assert.equal(ref.externalListingId, null);
  assert.equal(ref.source, "none");
});

test("channel missing from the projection → null id, source none", async () => {
  const resolver = createProjectionIdentityResolver(async () => ({
    degraded: false, projections: [proj("shopify", null, "live_match")],
  }));
  const ref = await resolver.resolve(store("talabat", "talabat:main"), { productId: "p1" });
  assert.equal(ref.externalListingId, null);
  assert.equal(ref.source, "none");
});
