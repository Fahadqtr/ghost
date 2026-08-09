// Platform Snapshot Engine — batch capture tests (Phase UI.9.3). PURE (fake store).
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/core/capture.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { captureSnapshots, type CaptureStore } from "./capture.ts";
import { createSnapshot, snapshotKey } from "./snapshot.ts";
import type { PlatformSnapshot, SnapshotInput } from "./types.ts";

/** Minimal in-memory CaptureStore: append-only, latest-per-key. */
function fakeStore() {
  const saved: PlatformSnapshot[] = [];
  const store: CaptureStore = {
    async listLatestByPlatform(platform) {
      const latest = new Map<string, PlatformSnapshot>();
      for (const s of saved) if (s.platform === platform) latest.set(snapshotKey(s), s); // last wins
      return [...latest.values()];
    },
    async saveSnapshots(list) {
      saved.push(...list);
    },
  };
  return { store, saved };
}

const input = (over: Partial<SnapshotInput>): SnapshotInput => ({
  platform: "pure_seoul",
  productId: "p1",
  capturedAt: "2026-01-01T00:00:00.000Z",
  price: 10,
  availability: "InStock",
  ...over,
});

test("first capture: all created and saved, events emitted", async () => {
  const { store, saved } = fakeStore();
  const r = await captureSnapshots(store, [input({ productId: "a" }), input({ productId: "b" })]);
  assert.equal(r.created, 2);
  assert.equal(r.changed, 0);
  assert.equal(r.unchanged, 0);
  assert.equal(saved.length, 2);
  assert.equal(r.events.length, 2);
  assert.equal(r.events.every((e) => e.kind === "created"), true);
});

test("idempotent: re-capturing identical inputs saves nothing", async () => {
  const { store, saved } = fakeStore();
  await captureSnapshots(store, [input({ productId: "a" })]);
  const r2 = await captureSnapshots(store, [input({ productId: "a", capturedAt: "2026-02-02T00:00:00.000Z" })]);
  assert.equal(r2.unchanged, 1);
  assert.equal(r2.created, 0);
  assert.equal(r2.changed, 0);
  assert.equal(saved.length, 1, "no duplicate row for identical payload");
  assert.equal(r2.events.length, 0, "unchanged emits no event");
});

test("changed payload creates a new snapshot", async () => {
  const { store, saved } = fakeStore();
  await captureSnapshots(store, [input({ productId: "a", price: 10 })]);
  const r2 = await captureSnapshots(store, [input({ productId: "a", price: 20, capturedAt: "2026-03-03T00:00:00.000Z" })]);
  assert.equal(r2.changed, 1);
  assert.equal(saved.length, 2);
  assert.equal(r2.events[0].kind, "changed");
  assert.deepEqual(r2.events[0].changes, ["price_changed"]);
});

test("empty inputs → no-op", async () => {
  const { store, saved } = fakeStore();
  const r = await captureSnapshots(store, []);
  assert.deepEqual([r.created, r.changed, r.unchanged, saved.length], [0, 0, 0, 0]);
});

test("mixed platforms diff against their own latest", async () => {
  const { store, saved } = fakeStore();
  await captureSnapshots(store, [input({ platform: "pure_seoul", productId: "a", price: 10 })]);
  const r = await captureSnapshots(store, [
    input({ platform: "pure_seoul", productId: "a", price: 10, capturedAt: "2026-04-04T00:00:00.000Z" }), // unchanged
    input({ platform: "shopify", productId: "a", price: 10, capturedAt: "2026-04-04T00:00:00.000Z" }), // created (other platform)
  ]);
  assert.equal(r.unchanged, 1);
  assert.equal(r.created, 1);
  assert.equal(saved.length, 2);
});

test("injected createSnapshot is used", async () => {
  const { store } = fakeStore();
  let calls = 0;
  await captureSnapshots(store, [input({ productId: "a" })], {
    createSnapshot: (i) => {
      calls++;
      return createSnapshot(i);
    },
  });
  assert.equal(calls, 1);
});
