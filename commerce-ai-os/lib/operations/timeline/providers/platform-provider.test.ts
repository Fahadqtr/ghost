// Phase UI.9.4 — platform timeline provider (pure): history entries → Timeline
// events that plug into the EXISTING engine (no engine change). Verifies source
// mapping, kinds, deterministic ids, values-free copy, and engine integration.
// Run: node --conditions=react-server --experimental-strip-types --test lib/operations/timeline/providers/platform-provider.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import type { PlatformHistoryEntry } from "../../../platforms/core/history";
import {
  createPlatformTimelineProviders,
  platformTimelineEvents,
  platformToTimelineSource,
} from "./platform-provider.ts";
import { createSnapshotTimelineProvider } from "./snapshot-provider.ts";
import { buildTimeline } from "../timeline-engine.ts";

function entry(over: Partial<PlatformHistoryEntry> = {}): PlatformHistoryEntry {
  return {
    productId: "p1",
    platform: "puresoul",
    changeType: "changed",
    fields: [{ field: "price", before: 100, after: 90 }],
    metadataChanged: false,
    capturedAt: "2026-01-02T00:00:00Z",
    snapshotVersion: 1,
    ...over,
  };
}

test("platformToTimelineSource maps known ids, null otherwise", () => {
  assert.equal(platformToTimelineSource("puresoul"), "puresoul");
  assert.equal(platformToTimelineSource("shopify"), "shopify");
  assert.equal(platformToTimelineSource("mystery"), null);
});

test("entry → event: kind, source, at, atKnown", () => {
  const ev = platformTimelineEvents([entry()], "puresoul");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, "platform_changed");
  assert.equal(ev[0].source, "puresoul");
  assert.equal(ev[0].productId, "p1");
  assert.equal(ev[0].at, "2026-01-02T00:00:00Z");
  assert.equal(ev[0].atKnown, true);
});

test("created entry → platform_created kind", () => {
  const ev = platformTimelineEvents([entry({ changeType: "created", fields: [] })], "puresoul");
  assert.equal(ev[0].kind, "platform_created");
});

test("event id is deterministic over source/type/product/time", () => {
  const a = platformTimelineEvents([entry()], "puresoul")[0];
  const b = platformTimelineEvents([entry()], "puresoul")[0];
  assert.equal(a.id, b.id);
  assert.equal(a.id, "platform:puresoul:changed:p1:2026-01-02T00:00:00Z");
});

test("title/description carry field LABELS, never VALUES", () => {
  const ev = platformTimelineEvents([entry({ fields: [{ field: "price", before: 100, after: 90 }] })], "puresoul")[0];
  assert.equal(ev.title.includes("PureSoul"), true);
  assert.equal(ev.description.includes("السعر"), true);
  assert.equal(ev.description.includes("90"), false); // no raw value
  assert.equal(ev.description.includes("100"), false);
});

test("entries without a productId are skipped (timeline needs a product)", () => {
  assert.equal(platformTimelineEvents([entry({ productId: null })], "puresoul").length, 0);
});

test("createPlatformTimelineProviders: one provider per known platform, skips unknown", () => {
  const providers = createPlatformTimelineProviders([
    entry({ platform: "puresoul" }),
    entry({ platform: "shopify" }),
    entry({ platform: "mystery" }), // unknown → skipped
  ]);
  assert.deepEqual(new Set(providers.map((p) => p.source)), new Set(["puresoul", "shopify"]));
});

test("plugs into the existing engine alongside the snapshot provider", () => {
  const snapshotProvider = createSnapshotTimelineProvider({
    id: "p1",
    sku: null, barcode: null, nameAr: null, nameEn: null, imageUrl: null,
    approval: "Approved", platformStatus: "",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: null,
  });
  const platformProviders = createPlatformTimelineProviders([
    entry({ capturedAt: "2026-01-03T00:00:00Z" }),
  ]);
  const events = buildTimeline([snapshotProvider, ...platformProviders]);
  // newest-first: the platform change (Jan 3) precedes the product created (Jan 1)
  assert.equal(events[0].kind, "platform_changed");
  assert.ok(events.some((e) => e.kind === "created"));
  // ids are unique across sources (engine dedupe safety)
  assert.equal(new Set(events.map((e) => e.id)).size, events.length);
});
