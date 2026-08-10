// Phase UI.9.7 — Rafeeq snapshot capture (server orchestration) tests.
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/rafeeq/snapshot-capture.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { captureRafeeqSnapshots } from "./snapshot-capture.ts";
import type { RafeeqProductRow } from "./capture-compute.ts";
import { captureSnapshots, type CaptureStore } from "../core/capture.ts";
import type { PlatformSnapshot, SnapshotInput } from "../core/types.ts";

const AT = "2026-08-10T10:00:00.000Z";
const PRODUCTS: RafeeqProductRow[] = [
  { id: "p1", sku: "S1", barcode: null, name_en: "One", name_ar: null, rafeeq_product_id: "R1" },
  { id: "p2", sku: "S2", barcode: null, name_en: "Two", name_ar: null, rafeeq_product_id: null },
];
const CHANNELS = [{ id: "cR", name: "Rafeeq" }];
const STATUS = new Map<string, string | null>([["p1", "Active"], ["p2", "Not Listed"]]);

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

const deps = (store: CaptureStore, channels = CHANNELS, statuses = STATUS, products = PRODUCTS) => ({
  loadChannels: async () => channels,
  loadChannelStatuses: async () => statuses,
  loadProducts: async () => products,
  store,
  capture: (s: CaptureStore, i: readonly SnapshotInput[]) => captureSnapshots(s, i),
});

test("resolved channel → snapshots created from the DB overlays", async () => {
  const store = new FakeStore();
  const r = await captureRafeeqSnapshots(null, AT, deps(store));
  assert.equal(r.ok, true);
  assert.equal(r.skipped, false);
  assert.equal(r.created, 2);
  assert.equal(store.saved.length, 2);
});

test("identical repeat writes 0 rows (idempotent)", async () => {
  const store = new FakeStore();
  await captureRafeeqSnapshots(null, AT, deps(store));
  const r2 = await captureRafeeqSnapshots(null, "2026-08-10T11:00:00.000Z", deps(store));
  assert.equal(r2.unchanged, 2);
  assert.equal(store.saved.length, 2);
});

test("missing Rafeeq channel → SKIPPED, no write", async () => {
  const store = new FakeStore();
  const r = await captureRafeeqSnapshots(null, AT, deps(store, [{ id: "c1", name: "Shopify" }]));
  assert.equal(r.skipped, true);
  assert.equal(store.saved.length, 0);
});

test("ambiguous Rafeeq channel → SKIPPED, no write (never guessed)", async () => {
  const store = new FakeStore();
  const r = await captureRafeeqSnapshots(null, AT, deps(store, [{ id: "c1", name: "Rafeeq" }, { id: "c2", name: "rafeeq" }]));
  assert.equal(r.skipped, true);
  assert.equal(store.saved.length, 0);
});

test("persistence failure is caught — never throws, returns fixed message", async () => {
  const throwing: CaptureStore = {
    async listLatestByPlatform() {
      return [];
    },
    async saveSnapshots() {
      throw new Error("db down");
    },
  };
  const r = await captureRafeeqSnapshots(null, AT, {
    loadChannels: async () => CHANNELS,
    loadChannelStatuses: async () => STATUS,
    loadProducts: async () => PRODUCTS,
    store: throwing,
    capture: (s, i) => captureSnapshots(s, i),
  });
  assert.equal(r.ok, false);
  assert.ok(r.error && !/db down/.test(r.error));
});

test("a read that throws is swallowed (best-effort)", async () => {
  const r = await captureRafeeqSnapshots(null, AT, {
    loadChannels: async () => {
      throw new Error("channels fail");
    },
  });
  assert.equal(r.ok, false);
  assert.ok(r.error);
});
