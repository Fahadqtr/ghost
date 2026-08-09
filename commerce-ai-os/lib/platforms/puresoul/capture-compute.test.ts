// PureSoul capture-compute tests (Phase UI.9.3). PURE — no db/network/clock.
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/puresoul/capture-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  computePureSoulVerdicts,
  verdictsToSnapshotInputs,
  classifyPureSoulSnapshot,
  isSnapshotStale,
  PURESOUL_SNAPSHOT_STALE_MS,
  type PsCatalogRow,
} from "./capture-compute.ts";
import { createSnapshot } from "../core/snapshot.ts";

const cat = (over: Partial<PsCatalogRow>): PsCatalogRow => ({ id: "p", name_en: "Rose Serum", price: 10, sku: "SKU", ...over });

test("matched active row → present + InStock; price equal → no priceDiff", () => {
  const v = computePureSoulVerdicts(
    [{ global_id: "spi1", name_en: "Rose Serum", price: "10", branchStatus: "active" }],
    [cat({ id: "p", pure_seoul_id: "spi1" })],
  );
  assert.equal(v.length, 1);
  assert.equal(v[0].verdict, "present");
  assert.equal(v[0].availability, "InStock");
  assert.equal(v[0].priceDiff, false);
  assert.equal(v[0].psSpi, "spi1");
});

test("matched inactive row → present + OutOfStock", () => {
  const v = computePureSoulVerdicts(
    [{ global_id: "spi1", name_en: "Rose Serum", price: "10", branchStatus: "inactive" }],
    [cat({ id: "p", pure_seoul_id: "spi1" })],
  );
  assert.equal(v[0].availability, "OutOfStock");
});

test("matched with different price → priceDiff true, psPrice recorded", () => {
  const v = computePureSoulVerdicts(
    [{ global_id: "spi1", name_en: "Rose Serum", price: "12", branchStatus: "active" }],
    [cat({ id: "p", pure_seoul_id: "spi1", price: 10 })],
  );
  assert.equal(v[0].priceDiff, true);
  assert.equal(v[0].psPrice, 12);
  assert.equal(v[0].malikaPrice, 10);
});

test("rejected approval → rejected flag", () => {
  const v = computePureSoulVerdicts(
    [{ global_id: "spi1", name_en: "Rose Serum", price: "10", approval: "Rejected", branchStatus: "active" }],
    [cat({ id: "p", pure_seoul_id: "spi1" })],
  );
  assert.equal(v[0].rejected, true);
});

test("catalog product absent from upload, no close name → MISSING (confident)", () => {
  const v = computePureSoulVerdicts(
    [{ global_id: "spi1", name_en: "Totally Different Widget", price: "5", branchStatus: "active" }],
    [cat({ id: "p", name_en: "Rose Serum" })],
  );
  const rose = v.find((x) => x.productId === "p")!;
  assert.equal(rose.verdict, "missing");
});

test("catalog product with a CLOSE upload name → REVIEW (not missing)", () => {
  // 3 shared tokens of 5 union ⇒ jaccard 0.6 (≥0.55), but not a subset ⇒ review.
  const v = computePureSoulVerdicts(
    [{ global_id: "spi1", name_en: "Rose Serum Night Gel", price: "5", branchStatus: "active" }],
    [cat({ id: "p", name_en: "Rose Serum Night Cream" })],
  );
  const rose = v.find((x) => x.productId === "p")!;
  assert.equal(rose.verdict, "review");
});

test("every catalog product yields exactly one verdict; extras are ignored", () => {
  const v = computePureSoulVerdicts(
    [
      { global_id: "spi1", name_en: "Rose Serum", price: "10", branchStatus: "active" },
      { global_id: "spiX", name_en: "PS Only Exclusive", price: "9", branchStatus: "active" }, // extra
    ],
    [cat({ id: "p1", pure_seoul_id: "spi1" }), cat({ id: "p2", name_en: "Missing Item" })],
  );
  assert.equal(v.length, 2);
  assert.deepEqual(v.map((x) => x.productId).sort(), ["p1", "p2"]);
});

test("verdictsToSnapshotInputs: missing records nothing PS-specific; capturedAt passthrough", () => {
  const [mi] = verdictsToSnapshotInputs(
    [{ productId: "p", sku: "S", barcode: null, psSpi: null, verdict: "missing", availability: null, rejected: false, priceDiff: false, psPrice: null, malikaPrice: 10, psName: null }],
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(mi.platform, "pure_seoul");
  assert.equal(mi.status, null);
  assert.equal(mi.price, null);
  assert.equal(mi.availability, null);
  assert.equal(mi.capturedAt, "2026-01-01T00:00:00.000Z");
  assert.deepEqual((mi.metadata as any).ps, { verdict: "missing", priceDiff: false, malikaPrice: 10 });
});

// ---- classifier ----
const snap = (over: Partial<Parameters<typeof createSnapshot>[0]>) =>
  createSnapshot({ platform: "pure_seoul", productId: "p", capturedAt: "2026-01-01T00:00:00.000Z", ...over });

test("classify: present+InStock → published", () => {
  assert.equal(classifyPureSoulSnapshot(snap({ availability: "InStock", status: "Approved", metadata: { ps: { verdict: "present", priceDiff: false } } })), "published");
});
test("classify: present+priceDiff → price_different", () => {
  assert.equal(classifyPureSoulSnapshot(snap({ availability: "InStock", metadata: { ps: { verdict: "present", priceDiff: true } } })), "price_different");
});
test("classify: present+OutOfStock → out_of_stock", () => {
  assert.equal(classifyPureSoulSnapshot(snap({ availability: "OutOfStock", metadata: { ps: { verdict: "present", priceDiff: false } } })), "out_of_stock");
});
test("classify: present+Rejected → review", () => {
  assert.equal(classifyPureSoulSnapshot(snap({ status: "Rejected", availability: "InStock", metadata: { ps: { verdict: "present" } } })), "review");
});
test("classify: verdict missing → missing", () => {
  assert.equal(classifyPureSoulSnapshot(snap({ metadata: { ps: { verdict: "missing" } } })), "missing");
});
test("classify: verdict review → review", () => {
  assert.equal(classifyPureSoulSnapshot(snap({ metadata: { ps: { verdict: "review" } } })), "review");
});
test("classify: snapshot with no ps meta → unknown (never invents missing)", () => {
  assert.equal(classifyPureSoulSnapshot(snap({})), "unknown");
});

// ---- freshness ----
test("isSnapshotStale: null/invalid → stale; within 24h → fresh; beyond → stale", () => {
  const now = Date.parse("2026-01-02T00:00:00.000Z");
  assert.equal(isSnapshotStale(null, now), true);
  assert.equal(isSnapshotStale("not-a-date", now), true);
  assert.equal(isSnapshotStale("2026-01-01T06:00:00.000Z", now), false); // 18h
  assert.equal(isSnapshotStale("2026-01-01T00:00:00.000Z", now), false); // exactly 24h → not stale
  assert.equal(isSnapshotStale("2025-12-31T23:00:00.000Z", now), true); // 25h
  assert.equal(PURESOUL_SNAPSHOT_STALE_MS, 24 * 60 * 60 * 1000);
});
