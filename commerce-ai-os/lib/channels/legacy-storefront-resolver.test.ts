// CH.5 Phase D — legacy storefront (fallback) resolver tests.
// node --conditions=react-server --experimental-strip-types --test lib/channels/legacy-storefront-resolver.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { createLegacyStorefrontResolver } from "./legacy-storefront-resolver.ts";
import { type StoreRef } from "../adapters/types.ts";

const store = (channel: StoreRef["channel"], key: string): StoreRef => ({
  channel, storeId: key, storeKey: key, label: key, listingGrain: "product",
});
const cols = { snoonu_id: "SN", pure_seoul_id: "PS", rafeeq_product_id: "RF" };
const resolver = createLegacyStorefrontResolver(async () => cols);

test("each storefront reads its OWN legacy column (Snoonu stores stay separate)", async () => {
  assert.equal((await resolver.resolve(store("snoonu", "snoonu:malikas"), { productId: "p" })).externalListingId, "SN");
  assert.equal((await resolver.resolve(store("snoonu", "snoonu:pure_seoul"), { productId: "p" })).externalListingId, "PS");
  assert.equal((await resolver.resolve(store("rafeeq", "rafeeq:malikas"), { productId: "p" })).externalListingId, "RF");
});

test("Shopify & Talabat have no legacy column → source none", async () => {
  const sh = await resolver.resolve(store("shopify", "shopify:malikas"), { productId: "p" });
  assert.equal(sh.externalListingId, null);
  assert.equal(sh.source, "none");
  const tb = await resolver.resolve(store("talabat", "talabat:malikas"), { productId: "p" });
  assert.equal(tb.externalListingId, null);
});

test("missing product row → null id, source none (never invents)", async () => {
  const r = createLegacyStorefrontResolver(async () => null);
  const ref = await r.resolve(store("snoonu", "snoonu:malikas"), { productId: "p" });
  assert.equal(ref.externalListingId, null);
  assert.equal(ref.source, "none");
});
