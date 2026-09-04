// Phase UI.9.6 — Talabat snapshot reader tests (server-only, injected deps).
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/talabat/snapshot-presence.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { loadTalabatSnapshotView, __resetTalabatSnapshotCache } from "./snapshot-presence.ts";
import { diffToSnapshotInputs, type TalabatCatalogRow } from "./capture-compute.ts";
import { createSnapshot } from "../core/snapshot.ts";
import type { PlatformSnapshot } from "../core/types.ts";

const CLIENT = {} as never;
const ours: TalabatCatalogRow[] = [
  { id: "p1", sku: "S1", barcode: null, name_en: "One", name_ar: null, eligible: true },
  { id: "p2", sku: "S2", barcode: null, name_en: "Two", name_ar: null, eligible: true },
];

function snaps(missing: string[], at: string): PlatformSnapshot[] {
  return diffToSnapshotInputs(ours, { ok: true, missing: missing.map((product_id) => ({ product_id })) }, at).map(createSnapshot);
}

test("snapshot verdicts win; mapping adds `linked` for products without a snapshot", async () => {
  __resetTalabatSnapshotCache();
  const now = Date.parse("2026-08-10T12:00:00.000Z");
  const view = await loadTalabatSnapshotView(CLIENT, {
    now: () => now,
    listLatest: async () => snaps(["p2"], "2026-08-10T11:00:00.000Z"), // p1 present, p2 missing
    loadLinkedProductIds: async () => new Set(["p1", "p3"]), // p1 has a snapshot (ignored), p3 gets linked
  });
  assert.equal(view.available, true);
  assert.equal(view.degraded, false);
  assert.equal(view.byProductId.get("p1"), "present"); // snapshot wins over mapping
  assert.equal(view.byProductId.get("p2"), "missing");
  assert.equal(view.byProductId.get("p3"), "linked"); // mapping-only → linked, never present/published
  assert.equal(view.lastCapturedAt, "2026-08-10T11:00:00.000Z");
  assert.equal(view.stale, false);
});

test("snapshot read failure → degraded, empty (never missing)", async () => {
  __resetTalabatSnapshotCache();
  const view = await loadTalabatSnapshotView(CLIENT, {
    now: () => 0,
    listLatest: async () => {
      throw new Error("boom");
    },
    loadLinkedProductIds: async () => new Set(["p1"]),
  });
  assert.equal(view.degraded, true);
  assert.equal(view.available, false);
  assert.equal(view.byProductId.size, 0);
});

test("mapping read is best-effort — its failure never breaks the snapshot view", async () => {
  __resetTalabatSnapshotCache();
  const now = Date.parse("2026-08-10T12:00:00.000Z");
  const view = await loadTalabatSnapshotView(CLIENT, {
    now: () => now,
    listLatest: async () => snaps(["p2"], "2026-08-10T11:00:00.000Z"),
    loadLinkedProductIds: async () => {
      throw new Error("mappings unreadable");
    },
  });
  // Snapshot verdicts still return; the mapping failure is swallowed (no linked
  // baseline), and NOTHING is reported as missing because of it.
  assert.equal(view.degraded, false);
  assert.equal(view.byProductId.get("p1"), "present");
  assert.equal(view.byProductId.get("p2"), "missing");
});

test("healthy but empty → available:false, not degraded, stale (no capture yet)", async () => {
  __resetTalabatSnapshotCache();
  const view = await loadTalabatSnapshotView(CLIENT, {
    now: () => 0,
    listLatest: async () => [],
    loadLinkedProductIds: async () => new Set(),
  });
  assert.equal(view.available, false);
  assert.equal(view.degraded, false);
  assert.equal(view.lastCapturedAt, null);
});

test("stale when newest snapshot older than 7 days", async () => {
  __resetTalabatSnapshotCache();
  const now = Date.parse("2026-08-10T12:00:00.000Z");
  const view = await loadTalabatSnapshotView(CLIENT, {
    now: () => now,
    listLatest: async () => snaps([], "2026-08-01T11:00:00.000Z"),
    loadLinkedProductIds: async () => new Set(),
  });
  assert.equal(view.stale, true);
});

test("successful reads are cached", async () => {
  __resetTalabatSnapshotCache();
  let calls = 0;
  const listLatest = async () => {
    calls++;
    return snaps([], "2026-08-10T11:00:00.000Z");
  };
  const now = Date.parse("2026-08-10T12:00:00.000Z");
  await loadTalabatSnapshotView(CLIENT, { now: () => now, listLatest, loadLinkedProductIds: async () => new Set() });
  await loadTalabatSnapshotView(CLIENT, { now: () => now, listLatest, loadLinkedProductIds: async () => new Set() });
  assert.equal(calls, 1);
});
