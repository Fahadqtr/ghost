// Phase UI.9.7 — Rafeeq snapshot adapter (PURE) tests.
// Run: node --experimental-strip-types --test lib/platforms/rafeeq/capture-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  RAFEEQ_PLATFORM,
  RAFEEQ_SNAPSHOT_STALE_MS,
  MAX_RAFEEQ_SNAPSHOT_INPUTS,
  resolveRafeeqChannelId,
  rafeeqVerdictFor,
  buildRafeeqSnapshotInputs,
  classifyRafeeqSnapshot,
  isSnapshotStale,
  type RafeeqProductRow,
} from "./capture-compute.ts";
import { createSnapshot } from "../core/snapshot.ts";
import { captureSnapshots, type CaptureStore } from "../core/capture.ts";
import type { PlatformSnapshot, SnapshotInput } from "../core/types.ts";

const AT = "2026-08-10T10:00:00.000Z";

const products: RafeeqProductRow[] = [
  { id: "p1", sku: "S1", barcode: "B1", name_en: "One", name_ar: "١", rafeeq_product_id: "R1" },
  { id: "p2", sku: "S2", barcode: null, name_en: "Two", name_ar: null, rafeeq_product_id: null },
  { id: "p3", sku: "S3", barcode: null, name_en: "Three", name_ar: null, rafeeq_product_id: null },
  { id: "p4", sku: "S4", barcode: null, name_en: "Four", name_ar: null, rafeeq_product_id: "R4" }, // id only, no status
  { id: "p5", sku: "S5", barcode: null, name_en: "Five", name_ar: null, rafeeq_product_id: null }, // nothing
];
const status = new Map<string, string | null>([
  ["p1", "Active"],
  ["p2", "Not Listed"],
  ["p3", "Draft"],
  // p4: no channel row (id only) · p5: nothing
]);

test("channel resolution is EXACT; missing/ambiguous => null (no ilike)", () => {
  assert.equal(resolveRafeeqChannelId([{ id: "c1", name: "Rafeeq" }]), "c1");
  assert.equal(resolveRafeeqChannelId([{ id: "c1", name: "rafeeq express" }]), null);
  assert.equal(resolveRafeeqChannelId([{ id: "c1", name: "rafeeq" }, { id: "c2", name: "Rafeeq" }]), null);
  assert.equal(resolveRafeeqChannelId([]), null);
});

test("verdict rules: Active=present, Not Listed=missing, Draft=linked, id-only=linked, none=null", () => {
  assert.equal(rafeeqVerdictFor("Active", null), "present");
  assert.equal(rafeeqVerdictFor("active", null), "present");
  assert.equal(rafeeqVerdictFor("Not Listed", null), "missing");
  assert.equal(rafeeqVerdictFor("Draft", null), "linked");
  assert.equal(rafeeqVerdictFor(null, "R4"), "linked");
  assert.equal(rafeeqVerdictFor("", null), null);
  assert.equal(rafeeqVerdictFor(null, null), null);
});

test("build inputs: correct verdict per product; no-signal product is skipped", () => {
  const inputs = buildRafeeqSnapshotInputs(products, status, AT);
  const byId = new Map(inputs.map((i) => [i.productId, i]));
  assert.equal(byId.get("p1")!.platform, RAFEEQ_PLATFORM);
  assert.equal(classifyRafeeqSnapshot(createSnapshot(byId.get("p1")!)), "present");
  assert.equal(classifyRafeeqSnapshot(createSnapshot(byId.get("p2")!)), "missing");
  assert.equal(classifyRafeeqSnapshot(createSnapshot(byId.get("p3")!)), "linked");
  assert.equal(classifyRafeeqSnapshot(createSnapshot(byId.get("p4")!)), "linked"); // id only
  assert.equal(byId.has("p5"), false, "no status + no id → unknown, never snapshotted");
});

test("externalId = rafeeq_product_id when known; price/availability ALWAYS null", () => {
  const inputs = buildRafeeqSnapshotInputs(products, status, AT);
  const byId = new Map(inputs.map((i) => [i.productId, i]));
  assert.equal(byId.get("p1")!.externalId, "R1");
  assert.equal(byId.get("p2")!.externalId, null);
  for (const i of inputs) {
    assert.equal(i.price, null);
    assert.equal(i.availability, null);
  }
});

test("status field carries the trusted internal channel status (not a verdict alias)", () => {
  const byId = new Map(buildRafeeqSnapshotInputs(products, status, AT).map((i) => [i.productId, i]));
  assert.equal(byId.get("p1")!.status, "Active");
  assert.equal(byId.get("p2")!.status, "Not Listed");
  assert.equal(byId.get("p4")!.status, null); // id-only, no channel row
});

test("classify: absence / no metadata => unknown (never missing)", () => {
  const bare = createSnapshot({ platform: RAFEEQ_PLATFORM, productId: "x", capturedAt: AT });
  assert.equal(classifyRafeeqSnapshot(bare), "unknown");
});

test("metadata carries only fixed flags — no secrets", () => {
  const snap = createSnapshot(buildRafeeqSnapshotInputs(products, status, AT)[0]!);
  const meta = JSON.stringify(snap.metadata);
  assert.equal(/token|secret|password|api[_-]?key/i.test(meta), false);
  assert.deepEqual(Object.keys((snap.metadata as { rafeeq: object }).rafeeq).sort(), ["channelStatus", "verdict"]);
});

test("bounded: never builds more than the cap", () => {
  const many: RafeeqProductRow[] = Array.from({ length: MAX_RAFEEQ_SNAPSHOT_INPUTS + 30 }, (_, n) => ({
    id: `p${n}`, sku: `S${n}`, barcode: null, name_en: `N${n}`, name_ar: null, rafeeq_product_id: `R${n}`,
  }));
  assert.equal(buildRafeeqSnapshotInputs(many, new Map(), AT).length, MAX_RAFEEQ_SNAPSHOT_INPUTS);
});

test("stale threshold is 7 days", () => {
  assert.equal(RAFEEQ_SNAPSHOT_STALE_MS, 7 * 24 * 60 * 60 * 1000);
  const now = Date.parse("2026-08-10T12:00:00.000Z");
  assert.equal(isSnapshotStale("2026-08-08T12:00:00.000Z", now), false);
  assert.equal(isSnapshotStale("2026-08-01T12:00:00.000Z", now), true);
  assert.equal(isSnapshotStale(null, now), true);
});

// ── capture through the generic engine (idempotency + status change) ──────────

class FakeStore implements CaptureStore {
  latest: PlatformSnapshot[] = [];
  saved: PlatformSnapshot[] = [];
  async listLatestByPlatform(): Promise<PlatformSnapshot[]> {
    return this.latest;
  }
  async saveSnapshots(s: readonly PlatformSnapshot[]): Promise<void> {
    this.saved.push(...s);
    this.latest = [...this.latest, ...s];
  }
}
const cap = (store: FakeStore, inputs: SnapshotInput[]) => captureSnapshots(store, inputs);

test("first capture creates; identical repeat writes 0 rows", async () => {
  const store = new FakeStore();
  const r1 = await cap(store, buildRafeeqSnapshotInputs(products, status, AT));
  assert.equal(r1.created, 4); // p1,p2,p3,p4 (p5 skipped)
  const r2 = await cap(store, buildRafeeqSnapshotInputs(products, status, "2026-08-10T11:00:00.000Z"));
  assert.equal(r2.unchanged, 4);
  assert.equal(r2.created + r2.changed, 0);
  assert.equal(store.saved.length, 4);
});

test("changed status (Active → Not Listed) is recorded as changed", async () => {
  const store = new FakeStore();
  await cap(store, buildRafeeqSnapshotInputs(products, status, AT));
  const status2 = new Map(status);
  status2.set("p1", "Not Listed"); // p1 flips present → missing
  const r = await cap(store, buildRafeeqSnapshotInputs(products, status2, "2026-08-10T11:00:00.000Z"));
  assert.equal(r.changed, 1);
  assert.equal(r.unchanged, 3);
});
