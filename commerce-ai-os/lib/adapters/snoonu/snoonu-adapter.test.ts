// CH.6A — Snoonu adapter foundation tests.
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/snoonu-adapter.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { createSnoonuAdapter } from "./snoonu-adapter.ts";
import { type ExternalIdentityResolver, type StoreRef } from "../types.ts";

// Fake ECL resolver: storefront-scoped SPIs (never deduped across stores).
const SPI: Record<string, Record<string, string>> = {
  p1: { "snoonu:malikas": "SPI-A", "snoonu:pure_seoul": "SPI-B" },
};
const resolver: ExternalIdentityResolver = {
  resolve: async (store, product) => ({
    storeKey: store.storeKey,
    externalListingId: SPI[product.productId]?.[store.storeKey] ?? null,
    source: SPI[product.productId]?.[store.storeKey] ? "products_column" : "none",
  }),
};

const store = (key: string): StoreRef => ({ channel: "snoonu", storeId: key, storeKey: key, label: key, listingGrain: "product" });

test("adapter is channel=snoonu with TWO explicit storefronts", () => {
  const a = createSnoonuAdapter({ resolver });
  assert.equal(a.channel, "snoonu");
  const keys = a.stores().map((s) => s.storeKey).sort();
  assert.deepEqual(keys, ["snoonu:malikas", "snoonu:pure_seoul"]);
  assert.deepEqual(a.identity().stores.map((s) => s.storeKey).sort(), keys);
});

test("only identity is live in CH.6A; sync/connector capabilities are declared but off", () => {
  const a = createSnoonuAdapter({ resolver });
  assert.equal(a.supports("identity"), true);
  for (const cap of ["listings", "catalogSync", "imageSync", "availabilitySync", "priceSync", "publish", "unpublish", "orderIngestion"] as const) {
    assert.equal(a.supports(cap), false, `${cap} off in CH.6A`);
  }
});

test("resolveListing returns the storefront's OWN SPI (no cross-store dedupe)", async () => {
  const a = createSnoonuAdapter({ resolver });
  const mal = await a.resolveListing(store("snoonu:malikas"), { productId: "p1" });
  const ps = await a.resolveListing(store("snoonu:pure_seoul"), { productId: "p1" });
  assert.equal(mal.externalListingId, "SPI-A");
  assert.equal(ps.externalListingId, "SPI-B");
  assert.notEqual(mal.externalListingId, ps.externalListingId);
});

test("an unknown / non-Snoonu store never guesses — returns none", async () => {
  const a = createSnoonuAdapter({ resolver });
  const alien = await a.resolveListing({ channel: "talabat", storeId: "talabat:malikas", storeKey: "talabat:malikas", label: "t", listingGrain: "variant" }, { productId: "p1" });
  assert.equal(alien.externalListingId, null);
  assert.equal(alien.source, "none");
});

test("mutating capabilities never mutate — they return not-implemented outcomes", async () => {
  const a = createSnoonuAdapter({ resolver });
  const s = store("snoonu:malikas");
  assert.equal((await a.syncCatalog(s, [{ productId: "p1" }])).ok, false);
  assert.equal((await a.syncAvailability(s, [{ productId: "p1" }])).degraded, true);
  assert.equal((await a.publish(s, [{ productId: "p1" }])).ok, false);
  assert.equal((await a.listListings(s)).ok, false);
  assert.equal((await a.ingestOrders(s)).ok, false);
});
