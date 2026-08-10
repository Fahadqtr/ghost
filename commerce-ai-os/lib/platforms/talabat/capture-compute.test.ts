// Phase UI.9.6 — Talabat snapshot adapter (PURE) tests.
// Run: node --experimental-strip-types --test lib/platforms/talabat/capture-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  TALABAT_PLATFORM,
  TALABAT_SNAPSHOT_STALE_MS,
  MAX_TALABAT_SNAPSHOT_INPUTS,
  diffToSnapshotInputs,
  classifyTalabatSnapshot,
  mappingsToLinkedProductIds,
  resolveTalabatChannelId,
  isSnapshotStale,
  type TalabatCatalogRow,
  type TalabatDiffResult,
} from "./capture-compute.ts";
import { createSnapshot } from "../core/snapshot.ts";
import { captureSnapshots, type CaptureStore } from "../core/capture.ts";
import type { PlatformSnapshot, SnapshotInput } from "../core/types.ts";

const AT = "2026-08-10T10:00:00.000Z";

const ours: TalabatCatalogRow[] = [
  { id: "p1", sku: "SKU1", barcode: "B1", name_en: "One", name_ar: "واحد", approval: "Approved" },
  { id: "p2", sku: "SKU2", barcode: "B2", name_en: "Two", name_ar: "اثنان", approval: "Approved" },
  { id: "p3", sku: "SKU3", barcode: null, name_en: "Three", name_ar: null, approval: "SentAI" }, // NOT approved
];

function diff(missingIds: string[]): TalabatDiffResult {
  return { ok: true, missing: missingIds.map((id) => ({ product_id: id })) };
}

test("upload present => present input; missing id => missing input; platform=talabat", () => {
  const inputs = diffToSnapshotInputs(ours, diff(["p2"]), AT);
  assert.equal(inputs.length, 2); // only Approved products (p3 excluded)
  const byId = new Map(inputs.map((i) => [i.productId, i]));
  assert.equal(byId.get("p1")!.platform, TALABAT_PLATFORM);
  assert.equal(byId.get("p1")!.status, "present");
  assert.equal(byId.get("p2")!.status, "missing");
  assert.equal(byId.has("p3"), false, "non-Approved products are never snapshotted");
});

test("price and availability are ALWAYS null (never invented)", () => {
  for (const i of diffToSnapshotInputs(ours, diff([]), AT)) {
    assert.equal(i.price, null);
    assert.equal(i.availability, null);
    assert.equal(i.externalId, null); // the upload carries no trusted Talabat id
  }
});

test("classify reads only the recorded verdict; absence => unknown", () => {
  const present = createSnapshot(diffToSnapshotInputs(ours, diff([]), AT)[0]!);
  assert.equal(classifyTalabatSnapshot(present), "present");
  const missing = createSnapshot(diffToSnapshotInputs(ours, diff(["p1"]), AT).find((i) => i.productId === "p1")!);
  assert.equal(classifyTalabatSnapshot(missing), "missing");
  // A snapshot with no talabat metadata → unknown (never missing).
  const bare = createSnapshot({ platform: TALABAT_PLATFORM, productId: "x", capturedAt: AT });
  assert.equal(classifyTalabatSnapshot(bare), "unknown");
});

test("mappings => linked ONLY when channel_product_id present + not archived", () => {
  const linked = mappingsToLinkedProductIds([
    { master_product_id: "p1", channel_product_id: "T-1", mapping_status: "active" },
    { master_product_id: "p2", channel_product_id: null, mapping_status: "active" }, // no external id → not linked
    { master_product_id: "p3", channel_product_id: "T-3", mapping_status: "archived" }, // archived → not linked
  ]);
  assert.deepEqual([...linked].sort(), ["p1"]);
});

test("channel resolution is EXACT name match; ambiguous/missing => null (no fuzzy)", () => {
  assert.equal(resolveTalabatChannelId([{ id: "c1", name: "Talabat" }]), "c1");
  assert.equal(resolveTalabatChannelId([{ id: "c1", name: "talabat express" }]), null);
  assert.equal(resolveTalabatChannelId([{ id: "c1", name: "talabat" }, { id: "c2", name: "Talabat" }]), null);
  assert.equal(resolveTalabatChannelId([]), null);
});

test("metadata carries only a fixed verdict flag — no secrets", () => {
  const snap = createSnapshot(diffToSnapshotInputs(ours, diff([]), AT)[0]!);
  const meta = JSON.stringify(snap.metadata);
  assert.equal(/token|secret|webhook|TALABAT_/i.test(meta), false);
  assert.deepEqual(Object.keys((snap.metadata as { talabat: object }).talabat).sort(), ["source", "verdict"]);
});

test("bounded: never builds more than the cap", () => {
  const many: TalabatCatalogRow[] = Array.from({ length: MAX_TALABAT_SNAPSHOT_INPUTS + 20 }, (_, n) => ({
    id: `p${n}`, sku: `S${n}`, barcode: null, name_en: `N${n}`, name_ar: null, approval: "Approved",
  }));
  assert.equal(diffToSnapshotInputs(many, diff([]), AT).length, MAX_TALABAT_SNAPSHOT_INPUTS);
});

test("a failed diff produces no inputs (absence is never a verdict)", () => {
  assert.equal(diffToSnapshotInputs(ours, { ok: false, missing: [] }, AT).length, 0);
});

test("stale threshold is 7 days", () => {
  assert.equal(TALABAT_SNAPSHOT_STALE_MS, 7 * 24 * 60 * 60 * 1000);
  const now = Date.parse("2026-08-10T12:00:00.000Z");
  assert.equal(isSnapshotStale("2026-08-08T12:00:00.000Z", now), false);
  assert.equal(isSnapshotStale("2026-08-01T12:00:00.000Z", now), true);
  assert.equal(isSnapshotStale(null, now), true);
});

// ── capture through the generic engine (idempotency + verdict change) ─────────

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

test("first upload creates; identical repeat writes 0 rows", async () => {
  const store = new FakeStore();
  const r1 = await cap(store, diffToSnapshotInputs(ours, diff(["p2"]), AT));
  assert.equal(r1.created, 2);
  const r2 = await cap(store, diffToSnapshotInputs(ours, diff(["p2"]), "2026-08-10T11:00:00.000Z"));
  assert.equal(r2.unchanged, 2);
  assert.equal(r2.created + r2.changed, 0);
  assert.equal(store.saved.length, 2);
});

test("changed verdict (present → missing) is recorded as changed", async () => {
  const store = new FakeStore();
  await cap(store, diffToSnapshotInputs(ours, diff([]), AT)); // p1,p2 present
  const r = await cap(store, diffToSnapshotInputs(ours, diff(["p1"]), "2026-08-10T11:00:00.000Z"));
  assert.equal(r.changed, 1); // p1 flipped to missing; p2 unchanged
  assert.equal(r.unchanged, 1);
});
