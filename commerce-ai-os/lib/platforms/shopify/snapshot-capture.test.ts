// Phase UI.9.5 — Shopify snapshot capture (server orchestration) tests.
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/shopify/snapshot-capture.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { captureShopifySnapshots, type ShopifyCatalogRead } from "./snapshot-capture.ts";
import type { ShopifyRowInput } from "./capture-compute.ts";
import type { CaptureStore } from "../core/capture.ts";
import { captureSnapshots } from "../core/capture.ts";
import type { PlatformSnapshot } from "../core/types.ts";

const AT = "2026-08-09T10:00:00.000Z";

function okRead(rows: ShopifyRowInput[]): ShopifyCatalogRead {
  return { status: "ok", shopifyAvailable: true, rows };
}
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

class FakeStore implements CaptureStore {
  latest: PlatformSnapshot[] = [];
  saved: PlatformSnapshot[] = [];
  async listLatestByPlatform(): Promise<PlatformSnapshot[]> {
    return this.latest;
  }
  async saveSnapshots(s: readonly PlatformSnapshot[]): Promise<void> {
    this.saved.push(...s);
    this.latest = [...this.latest, ...s];
  }
}

test("trusted read → created snapshots (reuses the read model rows)", async () => {
  const store = new FakeStore();
  const r = await captureShopifySnapshots(null, AT, {
    loadCatalog: async () => okRead([row({ masterProductId: "p1" }), row({ masterProductId: "p2" })]),
    store,
    capture: (s, i) => captureSnapshots(s, i),
  });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, false);
  assert.equal(r.created, 2);
  assert.equal(store.saved.length, 2);
});

test("identical repeat writes 0 rows (idempotent)", async () => {
  const store = new FakeStore();
  const deps = {
    loadCatalog: async () => okRead([row({})]),
    store,
    capture: (s: CaptureStore, i: readonly import("../core/types.ts").SnapshotInput[]) => captureSnapshots(s, i),
  };
  await captureShopifySnapshots(null, AT, deps);
  const r2 = await captureShopifySnapshots(null, "2026-08-09T11:00:00.000Z", deps);
  assert.equal(r2.unchanged, 1);
  assert.equal(store.saved.length, 1);
});

test("degraded read → SKIPPED, no write (never records missing)", async () => {
  const store = new FakeStore();
  for (const read of [
    { status: "shopify_unavailable", shopifyAvailable: false, rows: [] },
    { status: "master_error", shopifyAvailable: false, rows: [] },
    { status: "ok", shopifyAvailable: false, rows: [] },
  ] as ShopifyCatalogRead[]) {
    const r = await captureShopifySnapshots(null, AT, {
      loadCatalog: async () => read,
      store,
      capture: (s, i) => captureSnapshots(s, i),
    });
    assert.equal(r.skipped, true);
    assert.equal(r.created, 0);
  }
  assert.equal(store.saved.length, 0);
});

test("persistence failure is caught — never throws, returns error", async () => {
  const throwingStore: CaptureStore = {
    async listLatestByPlatform() {
      return [];
    },
    async saveSnapshots() {
      throw new Error("db down");
    },
  };
  const r = await captureShopifySnapshots(null, AT, {
    loadCatalog: async () => okRead([row({})]),
    store: throwingStore,
    capture: (s, i) => captureSnapshots(s, i),
  });
  assert.equal(r.ok, false);
  assert.ok(r.error && !/db down/.test(r.error)); // fixed message, never the raw error
});

test("a read that throws is swallowed (best-effort)", async () => {
  const r = await captureShopifySnapshots(null, AT, {
    loadCatalog: async () => {
      throw new Error("network");
    },
  });
  assert.equal(r.ok, false);
  assert.ok(r.error);
});
