// CH.4 — Shopify reference adapter tests (fakes injected; no network).
// node --conditions=react-server --experimental-strip-types --test lib/adapters/shopify/shopify-adapter.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { createShopifyAdapter, type ShopifyAdapterDeps } from "./shopify-adapter.ts";
import { SHOPIFY_MAIN_STORE } from "./store.ts";
import { ADAPTER_CAPABILITIES, type StoreRef } from "../types.ts";

function deps(overrides: Partial<ShopifyAdapterDeps> = {}): ShopifyAdapterDeps {
  return {
    resolver: { resolve: async (s) => ({ storeKey: s.storeKey, externalListingId: "gid://p/1", source: "live_match" }) },
    listListings: async () => ({ products: [{ externalListingId: "gid://p/1", title: "Cream", sku: "MK-1", status: "ACTIVE" }] }),
    syncCatalog: async () => ({ ok: true, updated: 2, failed: [] }),
    syncImages: async () => ({ ok: true, updated: 1, failed: [{ name: "X", error: "broken" }] }),
    syncAvailability: async () => ({ ok: true, matched: 5, updated: 3 }),
    syncPrices: async () => ({ ok: true, updated: 4, failed: [] }),
    publish: async () => ({ ok: true, created: 2, skipped: 1, failed: [] }),
    unpublish: async () => ({ ok: true, updated: 2, failed: [] }),
    ingestOrders: async () => ({ ok: true, ingested: 7, skipped: 0 }),
    ...overrides,
  };
}

const P = [{ productId: "a" }, { productId: "b" }];

test("identity: channel, all nine capabilities, one store", () => {
  const a = createShopifyAdapter(deps());
  const id = a.identity();
  assert.equal(id.channel, "shopify");
  assert.equal(id.capabilities.length, 9);
  assert.equal(id.stores.length, 1);
  assert.equal(id.stores[0].storeKey, "shopify:main");
  for (const cap of ADAPTER_CAPABILITIES) assert.equal(a.supports(cap), true);
});

test("resolveListing delegates to the injected CH.2 resolver", async () => {
  const a = createShopifyAdapter(deps());
  const ref = await a.resolveListing(SHOPIFY_MAIN_STORE, { productId: "a" });
  assert.equal(ref.externalListingId, "gid://p/1");
  assert.equal(ref.source, "live_match");
});

test("listListings maps the native products", async () => {
  const a = createShopifyAdapter(deps());
  const r = await a.listListings(SHOPIFY_MAIN_STORE);
  assert.equal(r.ok, true);
  assert.equal(r.listings[0].sku, "MK-1");
});

test("syncCatalog/Images/Prices normalize apply-native → SyncOutcome", async () => {
  const a = createShopifyAdapter(deps());
  const cat = await a.syncCatalog(SHOPIFY_MAIN_STORE, P);
  assert.deepEqual([cat.ok, cat.processed, cat.updated, cat.failed], [true, 2, 2, 0]);

  const img = await a.syncImages(SHOPIFY_MAIN_STORE, P);
  assert.equal(img.failed, 1);
  assert.deepEqual(img.errors, ["X: broken"]); // failed[] flattened to messages
});

test("syncAvailability normalizes inventory-native (matched→processed)", async () => {
  const a = createShopifyAdapter(deps());
  const av = await a.syncAvailability(SHOPIFY_MAIN_STORE, P);
  assert.deepEqual([av.ok, av.processed, av.updated], [true, 5, 3]);
});

test("publish/unpublish normalize to PublishOutcome", async () => {
  const a = createShopifyAdapter(deps());
  const pub = await a.publish(SHOPIFY_MAIN_STORE, P);
  assert.deepEqual([pub.ok, pub.changed, pub.failed], [true, 2, 0]); // created→changed
  const un = await a.unpublish(SHOPIFY_MAIN_STORE, P);
  assert.deepEqual([un.ok, un.changed], [true, 2]); // updated→changed
});

test("ingestOrders returns the ingest count (never deducts)", async () => {
  const a = createShopifyAdapter(deps());
  const r = await a.ingestOrders(SHOPIFY_MAIN_STORE, { sinceHours: 24 });
  assert.deepEqual([r.ok, r.ingested, r.skipped], [true, 7, 0]);
});

test("a wrong-channel / unknown store degrades — never a partial write", async () => {
  const a = createShopifyAdapter(deps());
  const alien: StoreRef = { channel: "talabat", storeId: "t", storeKey: "talabat:main", label: "t", listingGrain: "variant" };
  const s = await a.syncPrices(alien, P);
  assert.equal(s.degraded, true);
  assert.equal(s.ok, false);
  const p = await a.publish(alien, P);
  assert.deepEqual([p.ok, p.failed], [false, P.length]);
});

test("delegation actually happens (dep called once)", async () => {
  let calls = 0;
  const a = createShopifyAdapter(deps({ syncPrices: async () => { calls++; return { ok: true, updated: 1, failed: [] }; } }));
  await a.syncPrices(SHOPIFY_MAIN_STORE, P);
  assert.equal(calls, 1);
});
