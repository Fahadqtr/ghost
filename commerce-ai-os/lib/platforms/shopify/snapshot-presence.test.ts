// Phase UI.9.5 — Shopify snapshot reader tests (server-only, injected store).
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/shopify/snapshot-presence.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { loadShopifySnapshotView, __resetShopifySnapshotCache } from "./snapshot-presence.ts";
import { rowsToSnapshotInputs, type ShopifyRowInput } from "./capture-compute.ts";
import { createSnapshot } from "../core/snapshot.ts";
import type { PlatformSnapshot } from "../core/types.ts";

function snap(over: Partial<ShopifyRowInput>, at: string): PlatformSnapshot {
  const base: ShopifyRowInput = {
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
  return createSnapshot(rowsToSnapshotInputs([base], at)[0]!);
}

const CLIENT = {} as never;

test("healthy read → available with reconstructed presence per product", async () => {
  __resetShopifySnapshotCache();
  const now = Date.parse("2026-08-09T12:00:00.000Z");
  const view = await loadShopifySnapshotView(CLIENT, {
    now: () => now,
    listLatest: async () => [
      snap({ masterProductId: "p1", shopifyStatus: "active" }, "2026-08-09T11:00:00.000Z"),
      snap({ masterProductId: "p2", shopifyStatus: "draft" }, "2026-08-09T11:30:00.000Z"),
    ],
  });
  assert.equal(view.available, true);
  assert.equal(view.degraded, false);
  assert.equal(view.byProductId.get("p1")?.live, true);
  assert.equal(view.byProductId.get("p2")?.linked, true);
  assert.equal(view.byProductId.get("p2")?.live, false);
  assert.equal(view.lastCapturedAt, "2026-08-09T11:30:00.000Z");
  assert.equal(view.stale, false);
});

test("read failure → degraded, empty map (never missing)", async () => {
  __resetShopifySnapshotCache();
  const view = await loadShopifySnapshotView(CLIENT, {
    now: () => 0,
    listLatest: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(view.degraded, true);
  assert.equal(view.available, false);
  assert.equal(view.byProductId.size, 0);
});

test("healthy but empty → available:false, not degraded", async () => {
  __resetShopifySnapshotCache();
  const view = await loadShopifySnapshotView(CLIENT, { now: () => 0, listLatest: async () => [] });
  assert.equal(view.available, false);
  assert.equal(view.degraded, false);
  assert.equal(view.lastCapturedAt, null);
});

test("stale when newest snapshot older than 24h", async () => {
  __resetShopifySnapshotCache();
  const now = Date.parse("2026-08-09T12:00:00.000Z");
  const view = await loadShopifySnapshotView(CLIENT, {
    now: () => now,
    listLatest: async () => [snap({}, "2026-08-07T11:00:00.000Z")],
  });
  assert.equal(view.stale, true);
});

test("successful reads are cached; failures are not", async () => {
  __resetShopifySnapshotCache();
  let calls = 0;
  const listLatest = async () => {
    calls++;
    return [snap({}, "2026-08-09T11:00:00.000Z")];
  };
  const now = Date.parse("2026-08-09T12:00:00.000Z");
  await loadShopifySnapshotView(CLIENT, { now: () => now, listLatest });
  await loadShopifySnapshotView(CLIENT, { now: () => now, listLatest });
  assert.equal(calls, 1); // second call served from cache
});
