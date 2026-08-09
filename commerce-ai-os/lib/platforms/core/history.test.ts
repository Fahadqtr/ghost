// Phase UI.9.4 — platform history builder (pure). Snapshots in → created/changed
// entries out (unchanged dropped), newest-first, leak-safe. No I/O, no clock.
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/core/history.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { createSnapshot } from "./snapshot.ts";
import type { SnapshotInput } from "./types.ts";
import {
  buildPlatformHistory,
  latestPreviousByPlatform,
} from "./history.ts";

function snap(over: Partial<SnapshotInput> & { capturedAt: string }) {
  return createSnapshot({
    platform: "puresoul",
    productId: "p1",
    price: 100,
    availability: "in_stock",
    status: "published",
    ...over,
  });
}

test("first snapshot → one created entry", () => {
  const h = buildPlatformHistory([snap({ capturedAt: "2026-01-01T00:00:00Z" })]);
  assert.equal(h.length, 1);
  assert.equal(h[0].changeType, "created");
  assert.equal(h[0].platform, "puresoul");
  assert.equal(h[0].productId, "p1");
  assert.equal(h[0].capturedAt, "2026-01-01T00:00:00Z");
});

test("price change → changed entry with before→after", () => {
  const h = buildPlatformHistory([
    snap({ capturedAt: "2026-01-01T00:00:00Z", price: 100 }),
    snap({ capturedAt: "2026-01-02T00:00:00Z", price: 90 }),
  ]);
  const changed = h.filter((e) => e.changeType === "changed");
  assert.equal(changed.length, 1);
  const price = changed[0].fields.find((f) => f.field === "price");
  assert.deepEqual(price, { field: "price", before: 100, after: 90 });
});

test("availability change → changed entry", () => {
  const h = buildPlatformHistory([
    snap({ capturedAt: "2026-01-01T00:00:00Z", availability: "in_stock" }),
    snap({ capturedAt: "2026-01-02T00:00:00Z", availability: "out_of_stock" }),
  ]);
  const d = h.find((e) => e.changeType === "changed")?.fields.find((f) => f.field === "availability");
  assert.deepEqual(d, { field: "availability", before: "in_stock", after: "out_of_stock" });
});

test("status change → changed entry", () => {
  const h = buildPlatformHistory([
    snap({ capturedAt: "2026-01-01T00:00:00Z", status: "published" }),
    snap({ capturedAt: "2026-01-02T00:00:00Z", status: "missing" }),
  ]);
  const d = h.find((e) => e.changeType === "changed")?.fields.find((f) => f.field === "status");
  assert.deepEqual(d, { field: "status", before: "published", after: "missing" });
});

test("unchanged repeat → no event (idempotent capture never duplicates)", () => {
  const h = buildPlatformHistory([
    snap({ capturedAt: "2026-01-01T00:00:00Z" }),
    snap({ capturedAt: "2026-01-02T00:00:00Z" }), // identical payload
    snap({ capturedAt: "2026-01-03T00:00:00Z" }), // identical payload
  ]);
  assert.equal(h.length, 1);
  assert.equal(h[0].changeType, "created");
});

test("multiple platforms → grouped independently", () => {
  const h = buildPlatformHistory([
    snap({ platform: "puresoul", capturedAt: "2026-01-01T00:00:00Z", price: 100 }),
    snap({ platform: "puresoul", capturedAt: "2026-01-02T00:00:00Z", price: 90 }),
    snap({ platform: "shopify", capturedAt: "2026-01-01T00:00:00Z", price: 100 }),
  ]);
  assert.equal(h.filter((e) => e.platform === "puresoul").length, 2); // created + changed
  assert.equal(h.filter((e) => e.platform === "shopify").length, 1); // created only
});

test("entries are newest-first", () => {
  const h = buildPlatformHistory([
    snap({ capturedAt: "2026-01-01T00:00:00Z", price: 100 }),
    snap({ capturedAt: "2026-01-02T00:00:00Z", price: 90 }),
    snap({ capturedAt: "2026-01-03T00:00:00Z", price: 80 }),
  ]);
  const times = h.map((e) => e.capturedAt);
  assert.deepEqual(times, [...times].sort().reverse());
  assert.equal(h[0].capturedAt, "2026-01-03T00:00:00Z");
});

test("distinct products stay separate (identity by platform+productId)", () => {
  const h = buildPlatformHistory([
    snap({ productId: "p1", capturedAt: "2026-01-01T00:00:00Z" }),
    snap({ productId: "p2", capturedAt: "2026-01-01T00:00:00Z" }),
  ]);
  assert.equal(h.length, 2);
  assert.deepEqual(new Set(h.map((e) => e.productId)), new Set(["p1", "p2"]));
});

test("metadata change is a flag only — raw metadata never leaks", () => {
  const secret = "SECRET_RAW_PAYLOAD_VALUE";
  const h = buildPlatformHistory([
    snap({ capturedAt: "2026-01-01T00:00:00Z", metadata: { raw: "before" } }),
    snap({ capturedAt: "2026-01-02T00:00:00Z", metadata: { raw: secret } }),
  ]);
  const changed = h.find((e) => e.changeType === "changed");
  assert.ok(changed, "a metadata-only change still emits a changed entry");
  assert.equal(changed!.metadataChanged, true);
  // no field delta named metadata, and the secret appears nowhere in the output
  assert.equal(changed!.fields.some((f) => (f.field as string) === "metadata"), false);
  assert.equal(JSON.stringify(h).includes(secret), false);
});

test("latestPreviousByPlatform: latest vs previous deltas", () => {
  const cmp = latestPreviousByPlatform([
    snap({ capturedAt: "2026-01-01T00:00:00Z", price: 100 }),
    snap({ capturedAt: "2026-01-02T00:00:00Z", price: 90 }),
  ]);
  assert.equal(cmp.length, 1);
  assert.equal(cmp[0].latest.price, 90);
  assert.equal(cmp[0].previous?.price, 100);
  assert.deepEqual(cmp[0].fields.find((f) => f.field === "price"), { field: "price", before: 100, after: 90 });
});

test("latestPreviousByPlatform: single snapshot → no previous", () => {
  const cmp = latestPreviousByPlatform([snap({ capturedAt: "2026-01-01T00:00:00Z" })]);
  assert.equal(cmp.length, 1);
  assert.equal(cmp[0].previous, null);
  assert.deepEqual(cmp[0].fields, []);
});

test("empty input → empty history and comparisons", () => {
  assert.deepEqual(buildPlatformHistory([]), []);
  assert.deepEqual(latestPreviousByPlatform([]), []);
});
