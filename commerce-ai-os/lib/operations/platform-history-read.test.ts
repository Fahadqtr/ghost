// Phase UI.9.4 — platform history reader: bounded, degraded-safe, leak-safe.
// Uses a fake store + the REAL engine wiring (injected) so the whole read path
// is exercised without a DB.
// Run: node --conditions=react-server --experimental-strip-types --test lib/operations/platform-history-read.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { createSnapshot } from "../platforms/core/snapshot.ts";
import type { PlatformSnapshot, SnapshotInput } from "../platforms/core/types";
import {
  createPlatformTimelineProviders,
} from "./timeline/providers/platform-provider.ts";
import { buildTimeline } from "./timeline/timeline-engine.ts";
import { loadProductPlatformHistory, type PlatformHistoryStore } from "./platform-history-read.ts";

const engines = { createPlatformTimelineProviders, buildTimeline };

function snap(over: Partial<SnapshotInput> & { capturedAt: string }): PlatformSnapshot {
  return createSnapshot({ platform: "puresoul", productId: "p1", price: 100, ...over });
}

function fakeStore(
  snapshots: PlatformSnapshot[],
  spy?: { productId?: string; opts?: unknown },
): PlatformHistoryStore {
  return {
    async listByProduct(productId, opts) {
      if (spy) { spy.productId = productId; spy.opts = opts; }
      return snapshots;
    },
  };
}

function throwingStore(): PlatformHistoryStore {
  return { async listByProduct() { throw new Error("db down"); } };
}

test("ok: builds entries + comparisons + engine events", async () => {
  const store = fakeStore([
    snap({ capturedAt: "2026-01-01T00:00:00Z", price: 100 }),
    snap({ capturedAt: "2026-01-02T00:00:00Z", price: 90 }),
  ]);
  const res = await loadProductPlatformHistory(null, "p1", { deps: { store, engines } });
  assert.equal(res.status, "ok");
  assert.equal(res.entries.length, 2); // created + changed
  assert.equal(res.comparisons.length, 1);
  assert.ok(res.events.length >= 1);
  assert.equal(res.events[0].source, "puresoul");
});

test("product with no snapshots → ok + empty", async () => {
  const res = await loadProductPlatformHistory(null, "p1", { deps: { store: fakeStore([]), engines } });
  assert.equal(res.status, "ok");
  assert.deepEqual(res.entries, []);
  assert.deepEqual(res.comparisons, []);
  assert.deepEqual(res.events, []);
});

test("read failure → error status, empty collections (no raw error)", async () => {
  const res = await loadProductPlatformHistory(null, "p1", { deps: { store: throwingStore(), engines } });
  assert.equal(res.status, "error");
  assert.deepEqual(res.entries, []);
  assert.deepEqual(res.events, []);
});

test("invalid id → ok empty, store never queried", async () => {
  let called = false;
  const store: PlatformHistoryStore = { async listByProduct() { called = true; return []; } };
  for (const bad of ["", "   ", "x".repeat(201)]) {
    const res = await loadProductPlatformHistory(null, bad, { deps: { store, engines } });
    assert.equal(res.status, "ok");
    assert.deepEqual(res.entries, []);
  }
  const res = await loadProductPlatformHistory(null, 123 as unknown, { deps: { store, engines } });
  assert.equal(res.status, "ok");
  assert.equal(called, false);
});

test("platform + limit scoping is passed through to the store", async () => {
  const spy: { productId?: string; opts?: unknown } = {};
  const store = fakeStore([snap({ capturedAt: "2026-01-01T00:00:00Z" })], spy);
  await loadProductPlatformHistory(null, "p1", { platform: "puresoul", limit: 50, deps: { store, engines } });
  assert.equal(spy.productId, "p1");
  assert.deepEqual(spy.opts, { platform: "puresoul", limit: 50 });
});

test("no raw metadata leakage end-to-end", async () => {
  const secret = "SECRET_RAW_PAYLOAD_VALUE";
  const store = fakeStore([
    snap({ capturedAt: "2026-01-01T00:00:00Z", metadata: { raw: "a" } }),
    snap({ capturedAt: "2026-01-02T00:00:00Z", metadata: { raw: secret } }),
  ]);
  const res = await loadProductPlatformHistory(null, "p1", { deps: { store, engines } });
  assert.equal(JSON.stringify(res).includes(secret), false);
});
