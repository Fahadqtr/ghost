// CH.5 — storefront registry tests.
// node --conditions=react-server --experimental-strip-types --test lib/channels/storefronts.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  STOREFRONTS, STOREFRONT_KEYS, storefrontByKey, storefrontsForChannel, storefrontsForUnit, parseStorefrontKey,
} from "./storefronts.ts";

test("the five real storefronts exist with canonical keys", () => {
  const keys = STOREFRONT_KEYS.slice().sort();
  assert.deepEqual(keys, ["rafeeq:malikas", "shopify:malikas", "snoonu:malikas", "snoonu:pure_seoul", "talabat:malikas"]);
});

test("keys are globally unique", () => {
  assert.equal(new Set(STOREFRONT_KEYS).size, STOREFRONTS.length);
});

test("Snoonu owns TWO storefronts (Malikas + Pure Seoul) under one channel", () => {
  const snoonu = storefrontsForChannel("snoonu").map((s) => s.key).sort();
  assert.deepEqual(snoonu, ["snoonu:malikas", "snoonu:pure_seoul"]);
  // Pure Seoul is a Snoonu storefront, NOT its own channel.
  assert.equal(storefrontsForChannel("pure_seoul").length, 0);
});

test("business units: Malikas has 4 storefronts, Pure Seoul has 1 (Snoonu)", () => {
  assert.equal(storefrontsForUnit("malikas").length, 4);
  const ps = storefrontsForUnit("pure_seoul");
  assert.equal(ps.length, 1);
  assert.equal(ps[0].key, "snoonu:pure_seoul");
  assert.equal(ps[0].channel, "snoonu");
});

test("Talabat is variant-grain; the rest are product-grain", () => {
  assert.equal(storefrontByKey("talabat:malikas")!.listingGrain, "variant");
  for (const k of ["shopify:malikas", "snoonu:malikas", "snoonu:pure_seoul", "rafeeq:malikas"]) {
    assert.equal(storefrontByKey(k)!.listingGrain, "product");
  }
});

test("identity types are channel-appropriate", () => {
  assert.equal(storefrontByKey("shopify:malikas")!.identityType, "shopify_gid");
  assert.equal(storefrontByKey("snoonu:malikas")!.identityType, "snoonu_spi");
  assert.equal(storefrontByKey("snoonu:pure_seoul")!.identityType, "snoonu_spi");
  assert.equal(storefrontByKey("rafeeq:malikas")!.identityType, "rafeeq_product_id");
  assert.equal(storefrontByKey("talabat:malikas")!.identityType, "talabat_sku");
});

test("parse/lookup return null for unknown keys", () => {
  assert.equal(parseStorefrontKey("nope:x"), null);
  assert.equal(storefrontByKey("shopify:main"), null); // CH.4 placeholder is not a CH.5 canonical key
});
