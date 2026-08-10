// Phase UI.9.7 — Rafeeq snapshot reader tests (server-only, injected deps).
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/rafeeq/snapshot-presence.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { loadRafeeqSnapshotView, __resetRafeeqSnapshotCache } from "./snapshot-presence.ts";
import { buildRafeeqSnapshotInputs, type RafeeqProductRow, type RafeeqState } from "./capture-compute.ts";
import { createSnapshot } from "../core/snapshot.ts";
import type { PlatformSnapshot } from "../core/types.ts";

const CLIENT = {} as never;
const products: RafeeqProductRow[] = [
  { id: "p1", sku: "S1", barcode: null, name_en: "One", name_ar: null, rafeeq_product_id: "R1" },
  { id: "p2", sku: "S2", barcode: null, name_en: "Two", name_ar: null, rafeeq_product_id: null },
];
function snaps(status: Map<string, string | null>, at: string): PlatformSnapshot[] {
  return buildRafeeqSnapshotInputs(products, status, at).map(createSnapshot);
}

test("snapshot verdicts win; baseline fills products without a snapshot", async () => {
  __resetRafeeqSnapshotCache();
  const now = Date.parse("2026-08-10T12:00:00.000Z");
  const view = await loadRafeeqSnapshotView(CLIENT, {
    now: () => now,
    listLatest: async () => snaps(new Map([["p1", "Active"]]), "2026-08-10T11:00:00.000Z"), // p1 present
    loadBaseline: async () => new Map<string, RafeeqState>([["p1", "missing"], ["p9", "linked"]]),
  });
  assert.equal(view.available, true);
  assert.equal(view.degraded, false);
  assert.equal(view.byProductId.get("p1"), "present"); // snapshot wins over baseline
  assert.equal(view.byProductId.get("p9"), "linked"); // baseline-only product
  assert.equal(view.lastCapturedAt, "2026-08-10T11:00:00.000Z");
  assert.equal(view.stale, false);
});

test("snapshot read failure → degraded, empty (never missing)", async () => {
  __resetRafeeqSnapshotCache();
  const view = await loadRafeeqSnapshotView(CLIENT, {
    now: () => 0,
    listLatest: async () => {
      throw new Error("boom");
    },
    loadBaseline: async () => new Map<string, RafeeqState>([["p1", "missing"]]),
  });
  assert.equal(view.degraded, true);
  assert.equal(view.available, false);
  assert.equal(view.byProductId.size, 0);
});

test("baseline read is best-effort — its failure never breaks the view", async () => {
  __resetRafeeqSnapshotCache();
  const now = Date.parse("2026-08-10T12:00:00.000Z");
  const view = await loadRafeeqSnapshotView(CLIENT, {
    now: () => now,
    listLatest: async () => snaps(new Map([["p1", "Active"]]), "2026-08-10T11:00:00.000Z"),
    loadBaseline: async () => {
      throw new Error("channels unreadable");
    },
  });
  assert.equal(view.degraded, false);
  assert.equal(view.byProductId.get("p1"), "present");
});

test("healthy but empty → available:false, not degraded", async () => {
  __resetRafeeqSnapshotCache();
  const view = await loadRafeeqSnapshotView(CLIENT, {
    now: () => 0,
    listLatest: async () => [],
    loadBaseline: async () => new Map(),
  });
  assert.equal(view.available, false);
  assert.equal(view.degraded, false);
  assert.equal(view.lastCapturedAt, null);
});

test("stale when newest snapshot older than 7 days", async () => {
  __resetRafeeqSnapshotCache();
  const now = Date.parse("2026-08-10T12:00:00.000Z");
  const view = await loadRafeeqSnapshotView(CLIENT, {
    now: () => now,
    listLatest: async () => snaps(new Map([["p1", "Active"]]), "2026-08-01T11:00:00.000Z"),
    loadBaseline: async () => new Map(),
  });
  assert.equal(view.stale, true);
});

test("successful reads are cached", async () => {
  __resetRafeeqSnapshotCache();
  let calls = 0;
  const listLatest = async () => {
    calls++;
    return snaps(new Map([["p1", "Active"]]), "2026-08-10T11:00:00.000Z");
  };
  const now = Date.parse("2026-08-10T12:00:00.000Z");
  await loadRafeeqSnapshotView(CLIENT, { now: () => now, listLatest, loadBaseline: async () => new Map() });
  await loadRafeeqSnapshotView(CLIENT, { now: () => now, listLatest, loadBaseline: async () => new Map() });
  assert.equal(calls, 1);
});
