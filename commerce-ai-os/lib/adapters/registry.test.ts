// CH.4 — registry + multi-store dispatch tests.
// node --conditions=react-server --experimental-strip-types --test lib/adapters/registry.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry, createRegistry } from "./registry.ts";
import {
  ADAPTER_CAPABILITIES,
  type ChannelAdapter,
  type ChannelKey,
  type StoreRef,
} from "./types.ts";

function fakeAdapter(channel: ChannelKey, stores: StoreRef[]): ChannelAdapter {
  const empty = { ok: true, processed: 0, updated: 0, failed: 0, errors: [] };
  return {
    channel,
    identity: () => ({ channel, label: channel, capabilities: ADAPTER_CAPABILITIES, stores }),
    stores: () => stores,
    supports: () => true,
    resolveListing: async (s) => ({ storeKey: s.storeKey, externalListingId: null, source: "none" }),
    listListings: async () => ({ ok: true, listings: [] }),
    syncCatalog: async () => empty,
    syncImages: async () => empty,
    syncAvailability: async () => empty,
    syncPrices: async () => empty,
    publish: async () => ({ ok: true, changed: 0, failed: 0, errors: [] }),
    unpublish: async () => ({ ok: true, changed: 0, failed: 0, errors: [] }),
    ingestOrders: async () => ({ ok: true, ingested: 0, skipped: 0, errors: [] }),
  };
}

const store = (channel: ChannelKey, key: string, grain: "product" | "variant" = "product"): StoreRef => ({
  channel, storeId: key, storeKey: key, label: key, listingGrain: grain,
});

test("register + get + has by channel", () => {
  const reg = new AdapterRegistry();
  const a = fakeAdapter("shopify", [store("shopify", "shopify:main")]);
  reg.register(a);
  assert.equal(reg.has("shopify"), true);
  assert.equal(reg.get("shopify"), a);
  assert.equal(reg.get("talabat"), null);
  assert.deepEqual(reg.channels(), ["shopify"]);
});

test("a single channel can own MANY stores (no one-store-per-channel assumption)", () => {
  // Simulates the future Snoonu shape: two storefronts under one channel.
  const snoonu = fakeAdapter("snoonu", [
    store("snoonu", "snoonu:malikas"),
    store("snoonu", "snoonu:pure_seoul"),
  ]);
  const reg = createRegistry([snoonu]);
  assert.equal(reg.storesFor("snoonu").length, 2);
  assert.deepEqual(reg.storesFor("snoonu").map((s) => s.storeKey), ["snoonu:malikas", "snoonu:pure_seoul"]);
});

test("stores() fans out across all adapters; storeByKey resolves owner", () => {
  const reg = createRegistry([
    fakeAdapter("shopify", [store("shopify", "shopify:main")]),
    fakeAdapter("talabat", [store("talabat", "talabat:main", "variant")]),
  ]);
  assert.equal(reg.stores().length, 2);
  const resolved = reg.storeByKey("talabat:main");
  assert.ok(resolved);
  assert.equal(resolved!.adapter.channel, "talabat");
  assert.equal(resolved!.store.listingGrain, "variant"); // Talabat flattens to variants
  assert.equal(reg.storeByKey("nope"), null);
});

test("register replaces an existing channel adapter", () => {
  const reg = new AdapterRegistry();
  reg.register(fakeAdapter("shopify", [store("shopify", "a")]));
  reg.register(fakeAdapter("shopify", [store("shopify", "b")]));
  assert.deepEqual(reg.storesFor("shopify").map((s) => s.storeKey), ["b"]);
});
