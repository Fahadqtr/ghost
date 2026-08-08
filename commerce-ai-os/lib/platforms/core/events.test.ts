// Platform Snapshot Engine — event tests (Phase UI.9.2). PURE.
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/core/events.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { createSnapshot } from "./snapshot.ts";
import { diffSnapshot } from "./diff.ts";
import { compareSnapshots } from "./compare.ts";
import { toDiffEvent, toDiffEvents, PLATFORM_DIFF_EVENT_TYPE } from "./events.ts";
import type { SnapshotInput } from "./types.ts";

const snap = (over: Partial<SnapshotInput>) =>
  createSnapshot({ platform: "puresoul", productId: "p1", externalId: "e1", price: 10, title: "x", capturedAt: "2026-01-01T00:00:00.000Z", ...over });

test("changed diff → event with flags and occurredAt from the present side", () => {
  const e = toDiffEvent(diffSnapshot(snap({ price: 10 }), snap({ price: 20, capturedAt: "2026-05-05T00:00:00.000Z" })));
  assert.ok(e);
  assert.equal(e!.type, PLATFORM_DIFF_EVENT_TYPE);
  assert.equal(e!.platform, "puresoul");
  assert.equal(e!.key, "puresoul::p1");
  assert.equal(e!.externalId, "e1");
  assert.equal(e!.kind, "changed");
  assert.deepEqual(e!.changes, ["price_changed"]);
  assert.equal(e!.occurredAt, "2026-05-05T00:00:00.000Z");
});

test("created & deleted produce events; unchanged produces none", () => {
  assert.equal(toDiffEvent(diffSnapshot(null, snap({})))?.kind, "created");
  assert.equal(toDiffEvent(diffSnapshot(snap({}), null))?.kind, "deleted");
  assert.equal(toDiffEvent(diffSnapshot(snap({}), snap({ capturedAt: "2026-02-02T00:00:00.000Z" }))), null);
});

test("toDiffEvents drops unchanged diffs", () => {
  const previous = [snap({ productId: "a" }), snap({ productId: "keep" })];
  const current = [snap({ productId: "a", price: 99 }), snap({ productId: "keep" }), snap({ productId: "new" })];
  const events = toDiffEvents(compareSnapshots(previous, current).diffs);
  // a=changed, keep=unchanged(dropped), new=created → 2 events
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.kind).sort(), ["changed", "created"]);
});

test("events are plain data (no Timeline coupling)", () => {
  const e = toDiffEvent(diffSnapshot(null, snap({})))!;
  assert.deepEqual(Object.keys(e).sort(), [
    "changes",
    "externalId",
    "key",
    "kind",
    "occurredAt",
    "platform",
    "productId",
    "snapshotVersion",
    "type",
  ]);
});
