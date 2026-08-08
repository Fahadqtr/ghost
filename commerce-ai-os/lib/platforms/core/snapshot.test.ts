// Platform Snapshot Engine — snapshot tests (Phase UI.9.2). PURE.
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/core/snapshot.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { createSnapshot, snapshotKey, snapshotsEqual, snapshotPayload } from "./snapshot.ts";
import { SNAPSHOT_VERSION } from "./types.ts";
import type { SnapshotInput } from "./types.ts";

const T = "2026-01-01T00:00:00.000Z";
const base = (over: Partial<SnapshotInput> = {}): SnapshotInput => ({
  platform: "shopify",
  productId: "p1",
  externalId: "ext1",
  sku: "SKU1",
  price: 10,
  availability: "InStock",
  title: "Item",
  status: "published",
  capturedAt: T,
  ...over,
});

test("createSnapshot stamps version, hash and keeps capturedAt verbatim", () => {
  const s = createSnapshot(base());
  assert.equal(s.snapshotVersion, SNAPSHOT_VERSION);
  assert.match(s.payloadHash, /^[0-9a-f]{64}$/);
  assert.equal(s.capturedAt, T);
});

test("identical content at DIFFERENT times → equal hash (equality is content-only)", () => {
  const a = createSnapshot(base({ capturedAt: "2026-01-01T00:00:00.000Z" }));
  const b = createSnapshot(base({ capturedAt: "2026-06-06T06:06:06.000Z" }));
  assert.equal(a.payloadHash, b.payloadHash);
  assert.ok(snapshotsEqual(a, b));
});

test("any payload change flips the hash", () => {
  const a = createSnapshot(base());
  assert.notEqual(a.payloadHash, createSnapshot(base({ price: 11 })).payloadHash);
  assert.notEqual(a.payloadHash, createSnapshot(base({ metadata: { promo: true } })).payloadHash);
});

test("normalization: blank strings → null, numeric strings → numbers", () => {
  const s = createSnapshot(base({ sku: "  ", barcode: "", price: "12.5" as unknown as number }));
  assert.equal(s.sku, null);
  assert.equal(s.barcode, null);
  assert.equal(s.price, 12.5);
});

test("metadata is frozen (snapshots are immutable)", () => {
  const s = createSnapshot(base({ metadata: { a: 1 } }));
  assert.throws(() => {
    (s.metadata as Record<string, unknown>).a = 2;
  });
});

test("snapshotKey prefers productId, then externalId, then sku, then barcode", () => {
  assert.equal(snapshotKey(createSnapshot(base())), "shopify::p1");
  assert.equal(snapshotKey(createSnapshot(base({ productId: null }))), "shopify::ext1");
  assert.equal(snapshotKey(createSnapshot(base({ productId: null, externalId: null }))), "shopify::SKU1");
  assert.equal(
    snapshotKey(createSnapshot(base({ productId: null, externalId: null, sku: null, barcode: "BC" }))),
    "shopify::BC",
  );
  assert.equal(
    snapshotKey(createSnapshot(base({ productId: null, externalId: null, sku: null, barcode: null }))),
    "shopify::anon",
  );
});

test("keys are platform-scoped (same product id, different platform → different key)", () => {
  assert.notEqual(
    snapshotKey(createSnapshot(base({ platform: "shopify" }))),
    snapshotKey(createSnapshot(base({ platform: "puresoul" }))),
  );
});

test("snapshotPayload excludes identity/version/time fields", () => {
  const p = snapshotPayload(base());
  assert.deepEqual(Object.keys(p).sort(), [
    "availability",
    "barcode",
    "externalId",
    "metadata",
    "price",
    "sku",
    "status",
    "title",
  ]);
});
