// Platform Snapshot Engine — set-compare tests (Phase UI.9.2). PURE.
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/core/compare.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { createSnapshot } from "./snapshot.ts";
import { compareSnapshots, summarizeDiffs } from "./compare.ts";
import type { SnapshotInput } from "./types.ts";

const T = "2026-01-01T00:00:00.000Z";
const snap = (over: Partial<SnapshotInput>) =>
  createSnapshot({ platform: "shopify", price: 10, availability: "InStock", title: "x", capturedAt: T, ...over });

test("created / deleted / changed / unchanged all detected in one pass", () => {
  const previous = [
    snap({ productId: "keep" }),
    snap({ productId: "gone" }),
    snap({ productId: "move", price: 10 }),
  ];
  const current = [
    snap({ productId: "keep" }), // unchanged
    snap({ productId: "move", price: 20 }), // changed
    snap({ productId: "new" }), // created
    // "gone" removed → deleted
  ];
  const { summary, diffs } = compareSnapshots(previous, current);
  assert.deepEqual(summary, { created: 1, deleted: 1, changed: 1, unchanged: 1, total: 4 });

  const byKey = new Map(diffs.map((d) => [d.key, d]));
  assert.equal(byKey.get("shopify::keep")?.kind, "unchanged");
  assert.equal(byKey.get("shopify::gone")?.kind, "deleted");
  assert.equal(byKey.get("shopify::move")?.kind, "changed");
  assert.equal(byKey.get("shopify::new")?.kind, "created");
});

test("empty previous → everything created", () => {
  const { summary } = compareSnapshots([], [snap({ productId: "a" }), snap({ productId: "b" })]);
  assert.deepEqual(summary, { created: 2, deleted: 0, changed: 0, unchanged: 0, total: 2 });
});

test("empty current → everything deleted", () => {
  const { summary } = compareSnapshots([snap({ productId: "a" })], []);
  assert.deepEqual(summary, { created: 0, deleted: 1, changed: 0, unchanged: 0, total: 1 });
});

test("spans MULTIPLE platforms — keys are platform-scoped", () => {
  const previous = [snap({ platform: "shopify", productId: "p" }), snap({ platform: "puresoul", productId: "p" })];
  const current = [
    snap({ platform: "shopify", productId: "p", price: 20 }), // changed
    snap({ platform: "puresoul", productId: "p" }), // unchanged
    snap({ platform: "talabat", productId: "p" }), // created
  ];
  const { summary } = compareSnapshots(previous, current);
  assert.deepEqual(summary, { created: 1, deleted: 0, changed: 1, unchanged: 1, total: 3 });
});

test("spans MULTIPLE products on one platform", () => {
  const previous = [snap({ productId: "a" }), snap({ productId: "b" }), snap({ productId: "c" })];
  const current = [snap({ productId: "a", title: "A2" }), snap({ productId: "b" })];
  const { summary } = compareSnapshots(previous, current);
  assert.deepEqual(summary, { created: 0, deleted: 1, changed: 1, unchanged: 1, total: 3 });
});

test("duplicate keys: last capture wins", () => {
  const previous = [snap({ productId: "a", price: 1 })];
  const current = [snap({ productId: "a", price: 2 }), snap({ productId: "a", price: 3 })];
  const { diffs } = compareSnapshots(previous, current);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].after?.price, 3);
});

test("summarizeDiffs matches compareSnapshots", () => {
  const { diffs, summary } = compareSnapshots([snap({ productId: "a" })], [snap({ productId: "b" })]);
  assert.deepEqual(summarizeDiffs(diffs), summary);
});
