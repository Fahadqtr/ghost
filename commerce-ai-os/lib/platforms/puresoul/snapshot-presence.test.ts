// PureSoul snapshot reader tests (Phase UI.9.3). Deps injected, no network.
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/puresoul/snapshot-presence.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { loadPureSoulSnapshotView, __resetPureSoulSnapshotCache } from "./snapshot-presence.ts";
import { createSnapshot } from "../core/snapshot.ts";
import type { PlatformSnapshot } from "../core/types.ts";

const client = {} as never;
const snap = (productId: string, capturedAt: string, meta: Record<string, unknown>, over: Record<string, unknown> = {}): PlatformSnapshot =>
  createSnapshot({ platform: "pure_seoul", productId, capturedAt, metadata: meta, ...over });

test("classifies each product; available + lastCapturedAt from newest", async () => {
  __resetPureSoulSnapshotCache();
  const snapshots = [
    snap("a", "2026-01-01T00:00:00.000Z", { ps: { verdict: "present", priceDiff: false } }, { availability: "InStock" }),
    snap("b", "2026-03-01T00:00:00.000Z", { ps: { verdict: "missing" } }),
    snap("c", "2026-02-01T00:00:00.000Z", { ps: { verdict: "present", priceDiff: true } }, { availability: "InStock" }),
  ];
  const v = await loadPureSoulSnapshotView(client, { listLatest: async () => snapshots, now: () => Date.parse("2026-03-01T01:00:00.000Z") });
  assert.equal(v.available, true);
  assert.equal(v.degraded, false);
  assert.equal(v.byProductId.get("a"), "published");
  assert.equal(v.byProductId.get("b"), "missing");
  assert.equal(v.byProductId.get("c"), "price_different");
  assert.equal(v.lastCapturedAt, "2026-03-01T00:00:00.000Z");
  assert.equal(v.stale, false);
});

test("stale when newest snapshot older than 24h", async () => {
  __resetPureSoulSnapshotCache();
  const v = await loadPureSoulSnapshotView(client, {
    listLatest: async () => [snap("a", "2026-01-01T00:00:00.000Z", { ps: { verdict: "missing" } })],
    now: () => Date.parse("2026-01-03T00:00:00.000Z"), // 48h later
  });
  assert.equal(v.stale, true);
});

test("read failure → degraded, empty, NOT cached (retries)", async () => {
  __resetPureSoulSnapshotCache();
  let calls = 0;
  const listLatest = async () => {
    calls++;
    throw new Error("no table");
  };
  const v = await loadPureSoulSnapshotView(client, { listLatest });
  assert.equal(v.degraded, true);
  assert.equal(v.available, false);
  assert.equal(v.byProductId.size, 0);
  await loadPureSoulSnapshotView(client, { listLatest });
  assert.equal(calls, 2, "degraded reads are not cached");
});

test("healthy-empty read → available:false, stale:true, cached", async () => {
  __resetPureSoulSnapshotCache();
  let calls = 0;
  const listLatest = async () => {
    calls++;
    return [];
  };
  const v = await loadPureSoulSnapshotView(client, { listLatest, now: () => 1000 });
  await loadPureSoulSnapshotView(client, { listLatest, now: () => 1000 });
  assert.equal(v.available, false);
  assert.equal(v.degraded, false);
  assert.equal(v.lastCapturedAt, null);
  assert.equal(v.stale, true);
  assert.equal(calls, 1, "healthy read cached");
});

test("cache expires after 90s", async () => {
  __resetPureSoulSnapshotCache();
  let calls = 0;
  const listLatest = async () => {
    calls++;
    return [snap("a", "2026-01-01T00:00:00.000Z", { ps: { verdict: "missing" } })];
  };
  let t = 10_000;
  await loadPureSoulSnapshotView(client, { listLatest, now: () => t });
  t += 89_000;
  await loadPureSoulSnapshotView(client, { listLatest, now: () => t });
  assert.equal(calls, 1);
  t += 2_000;
  await loadPureSoulSnapshotView(client, { listLatest, now: () => t });
  assert.equal(calls, 2);
});
