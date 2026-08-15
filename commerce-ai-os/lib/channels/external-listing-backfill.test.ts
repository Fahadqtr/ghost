// CH.5 — deterministic backfill projection + conflict report tests.
// node --conditions=react-server --experimental-strip-types --test lib/channels/external-listing-backfill.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { projectBackfill, storefrontFromChannelName } from "./external-listing-backfill.ts";

test("product columns project to the right storefronts (SPIs are storefront-scoped)", () => {
  const { records } = projectBackfill([
    { id: "p1", snoonu_id: "SPI-A", pure_seoul_id: "SPI-B", rafeeq_product_id: "RF-1" },
  ]);
  const byStore = new Map(records.map((r) => [r.storefrontKey, r]));
  assert.equal(byStore.get("snoonu:malikas")!.externalProductId, "SPI-A");
  assert.equal(byStore.get("snoonu:pure_seoul")!.externalProductId, "SPI-B"); // independent SPI
  assert.equal(byStore.get("rafeeq:malikas")!.externalProductId, "RF-1");
  assert.equal(records.length, 3); // one internal product → three external listings
});

test("channel name → storefront resolution (Pure Seoul disambiguated)", () => {
  assert.equal(storefrontFromChannelName("Malika's Universe (Snoonu)"), "snoonu:malikas");
  assert.equal(storefrontFromChannelName("Pure Seoul (Snoonu)"), "snoonu:pure_seoul");
  assert.equal(storefrontFromChannelName("Talabat"), "talabat:malikas");
  assert.equal(storefrontFromChannelName("Something Unknown"), null);
});

test("Talabat channel_variant_mappings project to variant-grain listings (never product-collapsed)", () => {
  const { records } = projectBackfill([], [
    { channel_name: "Talabat", master_product_id: "p1", master_variant_sku: "MK-1-A", exported_sku: "MK-1-A", exported_barcode: "29001", channel_product_id: null, mapping_status: "active" },
    { channel_name: "Talabat", master_product_id: "p1", master_variant_sku: "MK-1-B", exported_sku: "MK-1-B", exported_barcode: "29002", channel_product_id: null, mapping_status: "active" },
  ]);
  assert.equal(records.length, 2);
  for (const r of records) {
    assert.equal(r.storefrontKey, "talabat:malikas");
    assert.equal(r.identityType, "talabat_sku");
    assert.notEqual(r.variantSku, null); // variant grain preserved
  }
  assert.deepEqual(records.map((r) => r.variantSku).sort(), ["MK-1-A", "MK-1-B"]);
});

test("duplicate external id across products → conflict + rows marked needs_review", () => {
  const { records, report } = projectBackfill([
    { id: "p1", snoonu_id: "DUP" },
    { id: "p2", snoonu_id: "DUP" }, // same SPI on two products in the same storefront
  ]);
  assert.equal(report.duplicateExternalIds.length, 1);
  assert.deepEqual(report.duplicateExternalIds[0].productIds.sort(), ["p1", "p2"]);
  assert.ok(records.every((r) => r.mappingStatus === "needs_review"));
  assert.ok(report.needsReview >= 2);
  assert.ok(report.conflicts >= 1);
});

test("Talabat variant gap (no variant sku, no exported sku) → needs_review + gap count", () => {
  const { report } = projectBackfill([], [
    { channel_name: "Talabat", master_product_id: "p1", master_variant_sku: null, exported_sku: null, exported_barcode: null, channel_product_id: null, mapping_status: "active" },
  ]);
  assert.equal(report.talabatGaps, 1);
  assert.ok(report.needsReview >= 1);
});

test("unresolved channel name → missingStorefront (never guessed)", () => {
  const { report } = projectBackfill([], [
    { channel_name: "Mystery Marketplace", master_product_id: "p1", master_variant_sku: "x", exported_sku: "x", exported_barcode: null, channel_product_id: null, mapping_status: "active" },
  ]);
  assert.equal(report.missingStorefront, 1);
});

test("clean data → zero conflicts", () => {
  const { report } = projectBackfill([
    { id: "p1", snoonu_id: "A1" },
    { id: "p2", pure_seoul_id: "B2" },
    { id: "p3", rafeeq_product_id: "C3" },
  ]);
  assert.equal(report.conflicts, 0);
  assert.equal(report.needsReview, 0);
  assert.deepEqual(report.bySource, { snoonu_malikas: 1, snoonu_pure_seoul: 1, rafeeq_malikas: 1, talabat_malikas: 0 });
});
