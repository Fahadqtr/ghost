// Phase UI.9.5 — Shopify snapshots flow into Platform History + Timeline through
// the UNCHANGED generic engine (no Shopify-specific logic in history/timeline).
// Run: node --experimental-strip-types --test lib/platforms/shopify/timeline-integration.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { rowsToSnapshotInputs, type ShopifyRowInput } from "./capture-compute.ts";
import { createSnapshot } from "../core/snapshot.ts";
import { buildPlatformHistory } from "../core/history.ts";
import { createPlatformTimelineProviders, platformToTimelineSource } from "../../operations/timeline/providers/platform-provider.ts";
import { buildTimeline } from "../../operations/timeline/timeline-engine.ts";

function row(over: Partial<ShopifyRowInput>): ShopifyRowInput {
  return {
    masterProductId: "p1",
    sku: "S",
    barcode: "B",
    nameAr: null,
    nameEn: "P",
    shopifyProductId: "gid://1",
    shopifyStatus: "active",
    presenceStatus: "present",
    matchStatus: "matched_sku",
    ...over,
  };
}

test("shopify platform id maps to the shopify timeline source", () => {
  assert.equal(platformToTimelineSource("shopify"), "shopify");
});

test("a captured Shopify snapshot becomes a shopify timeline event", () => {
  const first = createSnapshot(rowsToSnapshotInputs([row({})], "2026-08-01T10:00:00.000Z")[0]!);
  const changed = createSnapshot(
    rowsToSnapshotInputs([row({ shopifyStatus: "draft" })], "2026-08-05T10:00:00.000Z")[0]!,
  );
  const entries = buildPlatformHistory([first, changed]);
  assert.equal(entries.length, 2); // created + changed (unchanged would emit none)

  const events = buildTimeline(createPlatformTimelineProviders(entries));
  assert.ok(events.length >= 2);
  for (const e of events) {
    assert.equal(e.source, "shopify");
    assert.ok(e.kind === "platform_created" || e.kind === "platform_changed");
    assert.equal(e.productId, "p1");
    // values-free: no raw status/sku/gid leaks into the card copy
    assert.equal(/gid:\/\/|matched_sku|draft|active/.test(`${e.title} ${e.description}`), false);
  }
});

test("identical repeat produces no timeline event (unchanged dropped)", () => {
  const a = createSnapshot(rowsToSnapshotInputs([row({})], "2026-08-01T10:00:00.000Z")[0]!);
  const b = createSnapshot(rowsToSnapshotInputs([row({})], "2026-08-02T10:00:00.000Z")[0]!);
  const entries = buildPlatformHistory([a, b]);
  assert.equal(entries.length, 1); // only the created entry; the repeat is unchanged
});
