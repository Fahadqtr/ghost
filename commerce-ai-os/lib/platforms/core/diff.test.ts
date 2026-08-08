// Platform Snapshot Engine — diff tests (Phase UI.9.2). PURE.
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/core/diff.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { createSnapshot } from "./snapshot.ts";
import { diffSnapshot } from "./diff.ts";
import type { SnapshotInput } from "./types.ts";

const base = (over: Partial<SnapshotInput> = {}): SnapshotInput => ({
  platform: "shopify",
  productId: "p1",
  externalId: "ext1",
  sku: "SKU1",
  barcode: "BC1",
  price: 10,
  availability: "InStock",
  title: "Item",
  status: "published",
  capturedAt: "2026-01-01T00:00:00.000Z",
  metadata: { color: "red" },
  ...over,
});
const snap = (over: Partial<SnapshotInput> = {}) => createSnapshot(base(over));

test("null → after = created", () => {
  const d = diffSnapshot(null, snap());
  assert.equal(d.kind, "created");
  assert.equal(d.key, "shopify::p1");
  assert.deepEqual(d.changes, []);
  assert.equal(d.after?.productId, "p1");
});

test("before → null = deleted", () => {
  const d = diffSnapshot(snap(), null);
  assert.equal(d.kind, "deleted");
  assert.deepEqual(d.changes, []);
  assert.equal(d.before?.productId, "p1");
});

test("identical content = unchanged (no deltas)", () => {
  const d = diffSnapshot(snap(), snap({ capturedAt: "2026-09-09T00:00:00.000Z" }));
  assert.equal(d.kind, "unchanged");
  assert.deepEqual(d.changes, []);
  assert.deepEqual(d.deltas, []);
});

test("both null throws", () => {
  assert.throws(() => diffSnapshot(null, null));
});

const cases: Array<[string, Partial<SnapshotInput>, string]> = [
  ["price", { price: 12 }, "price_changed"],
  ["availability", { availability: "OutOfStock" }, "availability_changed"],
  ["title", { title: "New" }, "title_changed"],
  ["status", { status: "rejected" }, "status_changed"],
  ["metadata", { metadata: { color: "blue" } }, "metadata_changed"],
  ["sku", { sku: "SKU2" }, "sku_changed"],
  ["barcode", { barcode: "BC2" }, "barcode_changed"],
  ["externalId", { externalId: "ext2" }, "external_id_changed"],
];

for (const [name, over, flag] of cases) {
  test(`changed: ${name} → ${flag} with before/after delta`, () => {
    const before = snap();
    const after = snap(over);
    const d = diffSnapshot(before, after);
    assert.equal(d.kind, "changed");
    assert.deepEqual(d.changes, [flag]);
    assert.equal(d.deltas.length, 1);
    assert.equal(d.deltas[0].field, flag);
    // before/after values are surfaced
    assert.notEqual(d.deltas[0].before, d.deltas[0].after);
  });
}

test("multiple field changes are all reported in fixed field order", () => {
  const d = diffSnapshot(snap(), snap({ status: "x", price: 99, title: "T2" }));
  assert.equal(d.kind, "changed");
  // fixed order: ...status, price, ...title
  assert.deepEqual(d.changes, ["status_changed", "price_changed", "title_changed"]);
});

test("metadata equality is order-independent (no false change)", () => {
  const before = snap({ metadata: { a: 1, b: 2 } });
  const after = snap({ metadata: { b: 2, a: 1 } });
  assert.equal(diffSnapshot(before, after).kind, "unchanged");
});
