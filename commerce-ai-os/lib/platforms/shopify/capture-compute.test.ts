// Phase UI.9.5 — Shopify snapshot adapter (PURE) tests.
// Run: node --experimental-strip-types --test lib/platforms/shopify/capture-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  SHOPIFY_PLATFORM,
  MAX_SHOPIFY_SNAPSHOT_INPUTS,
  rollupShopifyRows,
  rowsToSnapshotInputs,
  snapshotToShopifyPresence,
  classifyShopifySnapshot,
  isSnapshotStale,
  SHOPIFY_SNAPSHOT_STALE_MS,
  type ShopifyRowInput,
} from "./capture-compute.ts";
import { createSnapshot } from "../core/snapshot.ts";
import { captureSnapshots, type CaptureStore } from "../core/capture.ts";
import type { PlatformSnapshot, SnapshotInput } from "../core/types.ts";

const AT = "2026-08-09T10:00:00.000Z";

function row(over: Partial<ShopifyRowInput>): ShopifyRowInput {
  return {
    masterProductId: "p1",
    sku: "SKU1",
    barcode: "BAR1",
    nameAr: "منتج",
    nameEn: "Product",
    shopifyProductId: "gid://shopify/Product/1",
    shopifyStatus: "active",
    presenceStatus: "present",
    matchStatus: "matched_sku",
    ...over,
  };
}

test("matched+active row → published presence input (platform=shopify)", () => {
  const inputs = rowsToSnapshotInputs([row({})], AT);
  assert.equal(inputs.length, 1);
  const i = inputs[0]!;
  assert.equal(i.platform, SHOPIFY_PLATFORM);
  assert.equal(i.productId, "p1");
  assert.equal(i.externalId, "gid://shopify/Product/1");
  assert.equal(i.sku, "SKU1");
  assert.equal(i.status, "active");
  // Honest: never records Shopify price/availability (read model exposes neither).
  assert.equal(i.price, null);
  assert.equal(i.availability, null);
  const snap = createSnapshot(i);
  assert.equal(classifyShopifySnapshot(snap), "published");
  const pres = snapshotToShopifyPresence(snap);
  assert.deepEqual(pres, { linked: true, live: true, drift: false, reviewRequired: false });
});

test("draft matched row → linked but not live → ready", () => {
  const inputs = rowsToSnapshotInputs([row({ shopifyStatus: "draft" })], AT);
  const snap = createSnapshot(inputs[0]!);
  assert.equal(classifyShopifySnapshot(snap), "ready");
  assert.deepEqual(snapshotToShopifyPresence(snap), { linked: true, live: false, drift: false, reviewRequired: false });
});

test("ambiguous row → reviewRequired, external id withheld", () => {
  const inputs = rowsToSnapshotInputs([row({ matchStatus: "ambiguous", shopifyProductId: null })], AT);
  const snap = createSnapshot(inputs[0]!);
  assert.equal(classifyShopifySnapshot(snap), "review");
  assert.equal(snap.externalId, null);
  assert.equal(snapshotToShopifyPresence(snap).reviewRequired, true);
});

test("confidently missing row → missing (trusted absence)", () => {
  const inputs = rowsToSnapshotInputs(
    [row({ matchStatus: "unmatched", presenceStatus: "missing", shopifyProductId: null, shopifyStatus: "unknown" })],
    AT,
  );
  const snap = createSnapshot(inputs[0]!);
  assert.equal(classifyShopifySnapshot(snap), "missing");
  assert.deepEqual(snapshotToShopifyPresence(snap), { linked: false, live: false, drift: false, reviewRequired: false });
});

test("unknown row (Shopify unavailable) is NEVER snapshotted", () => {
  assert.equal(rowsToSnapshotInputs([row({ matchStatus: "unknown", presenceStatus: "unknown" })], AT).length, 0);
  assert.equal(rollupShopifyRows([row({ presenceStatus: "unknown", matchStatus: "unknown" })]).length, 0);
});

test("multiple variant rows roll up to ONE product snapshot (any live ⇒ live)", () => {
  const rows: ShopifyRowInput[] = [
    row({ masterProductId: "p1", sku: "A", shopifyStatus: "draft", matchStatus: "matched_sku", shopifyProductId: "gid://1" }),
    row({ masterProductId: "p1", sku: "B", shopifyStatus: "active", matchStatus: "matched_sku", shopifyProductId: "gid://2" }),
  ];
  const rolled = rollupShopifyRows(rows);
  assert.equal(rolled.length, 1);
  const inputs = rowsToSnapshotInputs(rows, AT);
  assert.equal(inputs.length, 1);
  const snap = createSnapshot(inputs[0]!);
  assert.equal(snapshotToShopifyPresence(snap).live, true); // one active variant makes the product live
  assert.equal(classifyShopifySnapshot(snap), "published");
});

test("distinct products never mix", () => {
  const rolled = rollupShopifyRows([row({ masterProductId: "p1" }), row({ masterProductId: "p2" })]);
  assert.deepEqual(rolled.map((r) => r.productId).sort(), ["p1", "p2"]);
});

test("bounded: never builds more than the cap", () => {
  const many: ShopifyRowInput[] = Array.from({ length: MAX_SHOPIFY_SNAPSHOT_INPUTS + 25 }, (_, n) =>
    row({ masterProductId: `p${n}` }),
  );
  assert.equal(rowsToSnapshotInputs(many, AT).length, MAX_SHOPIFY_SNAPSHOT_INPUTS);
});

test("metadata carries NO secret / token / domain — only fixed flags", () => {
  const snap = createSnapshot(rowsToSnapshotInputs([row({})], AT)[0]!);
  const meta = JSON.stringify(snap.metadata);
  assert.equal(/token|secret|myshopify|password|admin_api|shpat_/i.test(meta), false);
  assert.deepEqual(Object.keys((snap.metadata as { shopify: object }).shopify).sort(), [
    "linked",
    "live",
    "presence",
    "reviewRequired",
  ]);
});

test("stale threshold is 24h", () => {
  assert.equal(SHOPIFY_SNAPSHOT_STALE_MS, 24 * 60 * 60 * 1000);
  const now = Date.parse("2026-08-09T12:00:00.000Z");
  assert.equal(isSnapshotStale("2026-08-09T11:00:00.000Z", now), false);
  assert.equal(isSnapshotStale("2026-08-08T11:00:00.000Z", now), true);
  assert.equal(isSnapshotStale(null, now), true);
});

// ── capture integration through the generic engine (idempotency + diffing) ────

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

async function cap(store: FakeStore, inputs: SnapshotInput[]) {
  return captureSnapshots(store, inputs);
}

test("first capture creates; identical repeat writes 0 rows", async () => {
  const store = new FakeStore();
  const inputs = rowsToSnapshotInputs([row({})], AT);
  const r1 = await cap(store, inputs);
  assert.equal(r1.created, 1);
  assert.equal(store.saved.length, 1);
  const r2 = await cap(store, rowsToSnapshotInputs([row({})], "2026-08-09T11:00:00.000Z"));
  assert.equal(r2.unchanged, 1);
  assert.equal(r2.created + r2.changed, 0);
  assert.equal(store.saved.length, 1); // no new rows
});

test("state change (published → missing) is recorded as changed", async () => {
  const store = new FakeStore();
  await cap(store, rowsToSnapshotInputs([row({})], AT));
  const r = await cap(
    store,
    rowsToSnapshotInputs(
      [row({ matchStatus: "unmatched", presenceStatus: "missing", shopifyProductId: null, shopifyStatus: "unknown" })],
      "2026-08-09T11:00:00.000Z",
    ),
  );
  assert.equal(r.changed, 1);
  assert.equal(store.saved.length, 2);
});

test("status change (active → draft) is recorded as changed", async () => {
  const store = new FakeStore();
  await cap(store, rowsToSnapshotInputs([row({})], AT));
  const r = await cap(store, rowsToSnapshotInputs([row({ shopifyStatus: "draft" })], "2026-08-09T11:00:00.000Z"));
  assert.equal(r.changed, 1);
});
