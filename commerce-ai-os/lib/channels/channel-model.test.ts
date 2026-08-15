// CH.2 — pure channel-model unit tests. Run:
// node --conditions=react-server --experimental-strip-types --test lib/channels/channel-model.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  CHANNEL_KEYS,
  channelKeyFromName,
  resolveChannelExternalId,
  projectProductChannels,
  type ChannelModelProduct,
} from "./channel-model.ts";

const PRODUCT: ChannelModelProduct = {
  id: "p1",
  snoonu_id: "SN-9",
  pure_seoul_id: "PS-4",
  rafeeq_product_id: "RF-7",
};

test("CHANNEL_KEYS are the five canonical channel keys", () => {
  assert.deepEqual([...CHANNEL_KEYS], ["shopify", "talabat", "snoonu", "pure_seoul", "rafeeq"]);
});

test("channelKeyFromName maps names/aliases; unknown -> null", () => {
  assert.equal(channelKeyFromName("Shopify"), "shopify");
  assert.equal(channelKeyFromName("Talabat QA"), "talabat");
  assert.equal(channelKeyFromName("Snoonu NonFood"), "snoonu");
  assert.equal(channelKeyFromName("Pure Seoul"), "pure_seoul");
  assert.equal(channelKeyFromName("pure_seoul"), "pure_seoul");
  assert.equal(channelKeyFromName("Rafeeq"), "rafeeq");
  assert.equal(channelKeyFromName("Deliveroo"), null);
  assert.equal(channelKeyFromName(null), null);
});

test("external id resolves from the correct source per channel (CH.0 mapping graph)", () => {
  assert.deepEqual(resolveChannelExternalId("snoonu", PRODUCT), { externalId: "SN-9", source: "products_column" });
  assert.deepEqual(resolveChannelExternalId("pure_seoul", PRODUCT), { externalId: "PS-4", source: "products_column" });
  assert.deepEqual(resolveChannelExternalId("rafeeq", PRODUCT), { externalId: "RF-7", source: "products_column" });
  assert.deepEqual(resolveChannelExternalId("talabat", PRODUCT, "TB-1"), { externalId: "TB-1", source: "channel_variant_mappings" });
  assert.deepEqual(resolveChannelExternalId("talabat", PRODUCT, null), { externalId: null, source: "none" });
  assert.deepEqual(resolveChannelExternalId("shopify", PRODUCT), { externalId: null, source: "live_match" });
});

test("missing external id classifies as source 'none' and unmapped", () => {
  const bare: ChannelModelProduct = { id: "p2", snoonu_id: null, pure_seoul_id: null, rafeeq_product_id: null };
  const proj = projectProductChannels({ product: bare });
  const snoonu = proj.find((p) => p.channel === "snoonu")!;
  assert.equal(snoonu.externalId, null);
  assert.equal(snoonu.externalIdSource, "none");
  assert.equal(snoonu.mappingPresent, false);
  // Shopify is present-by-identity even without a persisted id (live SKU/title match).
  const shopify = proj.find((p) => p.channel === "shopify")!;
  assert.equal(shopify.mappingPresent, true);
  assert.equal(shopify.externalIdSource, "live_match");
});

test("projection yields exactly one row per channel with the right availability mode", () => {
  const proj = projectProductChannels({ product: PRODUCT });
  assert.equal(proj.length, 5);
  const mode = Object.fromEntries(proj.map((p) => [p.channel, p.availabilityMode]));
  assert.equal(mode.shopify, "push_zero_on_oos");
  assert.equal(mode.talabat, "export_flag");
  assert.equal(mode.snoonu, "none");
  assert.equal(mode.pure_seoul, "none");
  assert.equal(mode.rafeeq, "none");
});

test("overlay + platform_status classify listing/availability/price sources", () => {
  const proj = projectProductChannels({
    product: PRODUCT,
    overlay: {
      shopify: { channel_status: "Active", channel_price: 25 },
      talabat: { channel_status: "Not Listed", channel_price: null },
    },
    platformStatus: {
      shopify: { approval: "Approved", availability: "InStock" },
      talabat: { approval: "Approved", availability: "OutOfStock" },
    },
  });
  const shopify = proj.find((p) => p.channel === "shopify")!;
  assert.equal(shopify.listingStatus, "Active");
  assert.equal(shopify.listingSource, "channel_products");
  assert.equal(shopify.availability, "InStock");
  assert.equal(shopify.availabilitySource, "platform_status");
  assert.equal(shopify.channelPrice, 25);
  assert.equal(shopify.priceSource, "channel_override");

  const talabat = proj.find((p) => p.channel === "talabat")!;
  assert.equal(talabat.availability, "OutOfStock");
  assert.equal(talabat.priceSource, "internal_base", "no override -> base price is authority");

  // a channel with no overlay/status rows -> everything 'none'/base
  const rafeeq = proj.find((p) => p.channel === "rafeeq")!;
  assert.equal(rafeeq.listingSource, "none");
  assert.equal(rafeeq.availabilitySource, "none");
  assert.equal(rafeeq.priceSource, "internal_base");
});

test("talabat durable external id flows through the projection", () => {
  const proj = projectProductChannels({ product: PRODUCT, talabatChannelProductId: "TB-99" });
  const talabat = proj.find((p) => p.channel === "talabat")!;
  assert.equal(talabat.externalId, "TB-99");
  assert.equal(talabat.externalIdSource, "channel_variant_mappings");
  assert.equal(talabat.mappingPresent, true);
});
