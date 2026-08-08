// Platform Snapshot Engine — storage tests (Phase UI.9.2). In-memory, no I/O.
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/core/storage.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { createSnapshot, snapshotKey } from "./snapshot.ts";
import { InMemorySnapshotStore } from "./storage.ts";
import type { SnapshotInput } from "./types.ts";

const snap = (over: Partial<SnapshotInput>) =>
  createSnapshot({ platform: "shopify", productId: "p1", price: 10, title: "x", capturedAt: "2026-01-01T00:00:00.000Z", ...over });

test("save then loadLatest returns the stored snapshot", async () => {
  const store = new InMemorySnapshotStore();
  const s = snap({});
  await store.saveSnapshot(s);
  assert.equal(await store.loadLatest(snapshotKey(s)), s);
});

test("loadLatest returns null for an unknown key", async () => {
  const store = new InMemorySnapshotStore();
  assert.equal(await store.loadLatest("shopify::nope"), null);
});

test("loadLatest picks the greatest capturedAt regardless of insertion order", async () => {
  const store = new InMemorySnapshotStore();
  await store.saveSnapshot(snap({ capturedAt: "2026-01-02T00:00:00.000Z", price: 20 }));
  await store.saveSnapshot(snap({ capturedAt: "2026-01-01T00:00:00.000Z", price: 10 }));
  const latest = await store.loadLatest("shopify::p1");
  assert.equal(latest?.price, 20);
});

test("compareLatest → created when nothing stored yet", async () => {
  const store = new InMemorySnapshotStore();
  const d = await store.compareLatest(snap({}));
  assert.equal(d.kind, "created");
});

test("compareLatest → changed / unchanged against the stored latest", async () => {
  const store = new InMemorySnapshotStore();
  await store.saveSnapshot(snap({ capturedAt: "2026-01-01T00:00:00.000Z", price: 10 }));

  const changed = await store.compareLatest(snap({ capturedAt: "2026-02-01T00:00:00.000Z", price: 15 }));
  assert.equal(changed.kind, "changed");
  assert.deepEqual(changed.changes, ["price_changed"]);

  const same = await store.compareLatest(snap({ capturedAt: "2026-03-01T00:00:00.000Z", price: 10 }));
  assert.equal(same.kind, "unchanged");
});

test("listSnapshots returns insertion order and filters by platform/productId/key", async () => {
  const store = new InMemorySnapshotStore();
  await store.saveSnapshot(snap({ platform: "shopify", productId: "a", price: 1 }));
  await store.saveSnapshot(snap({ platform: "puresoul", productId: "a", price: 2 }));
  await store.saveSnapshot(snap({ platform: "shopify", productId: "b", price: 3 }));

  const all = await store.listSnapshots();
  assert.deepEqual(all.map((s) => s.price), [1, 2, 3]);

  assert.equal((await store.listSnapshots({ platform: "puresoul" })).length, 1);
  assert.equal((await store.listSnapshots({ productId: "a" })).length, 2);
  assert.deepEqual((await store.listSnapshots({ key: "shopify::b" })).map((s) => s.price), [3]);
});

test("append-only history: multiple platforms + products coexist", async () => {
  const store = new InMemorySnapshotStore();
  for (const platform of ["shopify", "puresoul", "talabat"]) {
    for (const productId of ["a", "b"]) {
      await store.saveSnapshot(snap({ platform, productId }));
    }
  }
  assert.equal((await store.listSnapshots()).length, 6);
  assert.equal((await store.loadLatest("talabat::b"))?.platform, "talabat");
});
