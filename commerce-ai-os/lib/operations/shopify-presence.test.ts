// Shopify presence cache tests (perf). The Shopify catalog loader is injected so
// this runs with no network; the module-level cache is reset before each case.
// Run: node --conditions=react-server --experimental-strip-types --test lib/operations/shopify-presence.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { loadShopifyPresence, __resetShopifyPresenceCache, type ShopifyCatalogLoader } from "./shopify-presence.ts";

// The client is only passed through to the (injected) loader here.
const fakeClient = {} as never;

test("caches a successful read: the loader runs once across calls within the TTL", async () => {
  __resetShopifyPresenceCache();
  const rows = [{ masterProductId: "p1", matchStatus: "matched_sku", shopifyStatus: "active" }];
  let calls = 0;
  const loadCatalog: ShopifyCatalogLoader = async () => {
    calls++;
    return { status: "ok", shopifyAvailable: true, rows };
  };
  const a = await loadShopifyPresence(fakeClient, { loadCatalog });
  const b = await loadShopifyPresence(fakeClient, { loadCatalog });
  assert.equal(calls, 1, "second call is served from cache");
  assert.equal(a.available, true);
  assert.equal(b.available, true);
  assert.equal(a.byProductId.get("p1")?.linked, true);
  assert.equal(a.byProductId.get("p1")?.live, true);
  assert.equal(a, b, "the same cached result object is returned");
});

test("does NOT cache a degraded read: the loader retries on each call", async () => {
  __resetShopifyPresenceCache();
  let calls = 0;
  const loadCatalog: ShopifyCatalogLoader = async () => {
    calls++;
    return { status: "shopify_unavailable", shopifyAvailable: false, rows: [] };
  };
  const a = await loadShopifyPresence(fakeClient, { loadCatalog });
  const b = await loadShopifyPresence(fakeClient, { loadCatalog });
  assert.equal(a.available, false);
  assert.equal(b.available, false);
  assert.equal(calls, 2, "degraded results are never pinned in the cache");
});

test("a throwing loader → degraded, and is not cached", async () => {
  __resetShopifyPresenceCache();
  let calls = 0;
  const loadCatalog: ShopifyCatalogLoader = async () => {
    calls++;
    throw new Error("shopify down");
  };
  const a = await loadShopifyPresence(fakeClient, { loadCatalog });
  assert.equal(a.available, false);
  await loadShopifyPresence(fakeClient, { loadCatalog });
  assert.equal(calls, 2, "a transient failure is retried, never cached");
});

test("__resetShopifyPresenceCache clears the cache", async () => {
  __resetShopifyPresenceCache();
  let calls = 0;
  const loadCatalog: ShopifyCatalogLoader = async () => {
    calls++;
    return { status: "ok", shopifyAvailable: true, rows: [] };
  };
  await loadShopifyPresence(fakeClient, { loadCatalog });
  await loadShopifyPresence(fakeClient, { loadCatalog });
  assert.equal(calls, 1, "cached within TTL");
  __resetShopifyPresenceCache();
  await loadShopifyPresence(fakeClient, { loadCatalog });
  assert.equal(calls, 2, "recomputed after reset");
});

test("cache expires after the 60s TTL (injected clock)", async () => {
  __resetShopifyPresenceCache();
  let calls = 0;
  const loadCatalog: ShopifyCatalogLoader = async () => {
    calls++;
    return { status: "ok", shopifyAvailable: true, rows: [] };
  };
  let t = 1_000;
  const now = () => t;
  await loadShopifyPresence(fakeClient, { loadCatalog, now }); // miss → calls=1
  t = 1_000 + 59_000;
  await loadShopifyPresence(fakeClient, { loadCatalog, now }); // within TTL → hit
  assert.equal(calls, 1, "served from cache within 60s");
  t = 1_000 + 60_001;
  await loadShopifyPresence(fakeClient, { loadCatalog, now }); // expired → recompute
  assert.equal(calls, 2, "recomputed after the 60s TTL expiry");
});

test("presence roll-up preserved: matched+active=live, ambiguous=reviewRequired, matched+draft=linked-not-live", async () => {
  __resetShopifyPresenceCache();
  const rows = [
    { masterProductId: "p1", matchStatus: "matched_barcode", shopifyStatus: "draft" },
    { masterProductId: "p2", matchStatus: "ambiguous", shopifyStatus: "active" },
  ];
  const loadCatalog: ShopifyCatalogLoader = async () => ({ status: "ok", shopifyAvailable: true, rows });
  const r = await loadShopifyPresence(fakeClient, { loadCatalog });
  assert.equal(r.byProductId.get("p1")?.linked, true);
  assert.equal(r.byProductId.get("p1")?.live, false);
  assert.equal(r.byProductId.get("p2")?.reviewRequired, true);
});
