// Phase UI.9.6 — Talabat snapshot capture (server orchestration) tests.
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/talabat/snapshot-capture.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { captureTalabatSnapshots } from "./snapshot-capture.ts";
import type { TalabatCatalogRow, TalabatDiffResult } from "./capture-compute.ts";
import { captureSnapshots, type CaptureStore } from "../core/capture.ts";
import type { PlatformSnapshot, SnapshotInput } from "../core/types.ts";

const AT = "2026-08-10T10:00:00.000Z";
const OURS: TalabatCatalogRow[] = [
  { id: "p1", sku: "S1", barcode: null, name_en: "One", name_ar: null, approval: "Approved" },
  { id: "p2", sku: "S2", barcode: null, name_en: "Two", name_ar: null, approval: "Approved" },
];
const SHEET = [{ SKU: "S1", Name: "One" }];

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

const deps = (store: CaptureStore, diff: TalabatDiffResult) => ({
  loadOurCatalog: async () => OURS,
  diff: () => diff,
  store,
  capture: (s: CaptureStore, i: readonly SnapshotInput[]) => captureSnapshots(s, i),
});

const okDiff = (missing: string[]): TalabatDiffResult => ({ ok: true, missing: missing.map((product_id) => ({ product_id })) });

test("successful upload diff → snapshots created (reuses the existing diff)", async () => {
  const store = new FakeStore();
  const r = await captureTalabatSnapshots(null, SHEET, AT, deps(store, okDiff(["p2"])));
  assert.equal(r.ok, true);
  assert.equal(r.skipped, false);
  assert.equal(r.created, 2);
  assert.equal(store.saved.length, 2);
});

test("identical repeat writes 0 rows (idempotent)", async () => {
  const store = new FakeStore();
  await captureTalabatSnapshots(null, SHEET, AT, deps(store, okDiff(["p2"])));
  const r2 = await captureTalabatSnapshots(null, SHEET, "2026-08-10T11:00:00.000Z", deps(store, okDiff(["p2"])));
  assert.equal(r2.unchanged, 2);
  assert.equal(store.saved.length, 2);
});

test("empty sheet → SKIPPED, no write", async () => {
  const store = new FakeStore();
  const r = await captureTalabatSnapshots(null, [], AT, deps(store, okDiff([])));
  assert.equal(r.skipped, true);
  assert.equal(store.saved.length, 0);
});

test("failed diff (unrecognized file) → SKIPPED, never records missing", async () => {
  const store = new FakeStore();
  const r = await captureTalabatSnapshots(null, SHEET, AT, deps(store, { ok: false, missing: [] }));
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
  const r = await captureTalabatSnapshots(null, SHEET, AT, {
    loadOurCatalog: async () => OURS,
    diff: () => okDiff([]),
    store: throwing,
    capture: (s, i) => captureSnapshots(s, i),
  });
  assert.equal(r.ok, false);
  assert.ok(r.error && !/db down/.test(r.error)); // fixed message, never the raw error
});

test("a catalog read that throws is swallowed (best-effort)", async () => {
  const r = await captureTalabatSnapshots(null, SHEET, AT, {
    loadOurCatalog: async () => {
      throw new Error("read fail");
    },
    diff: () => okDiff([]),
  });
  assert.equal(r.ok, false);
  assert.ok(r.error);
});
