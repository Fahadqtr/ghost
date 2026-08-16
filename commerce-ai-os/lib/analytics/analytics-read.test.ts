// BI.1 — Analytics Read Layer, pure-core tests.
// node --conditions=react-server --experimental-strip-types --test lib/analytics/analytics-read.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  available,
  unknown,
  fromNullable,
  buildAnalyticsSnapshot,
  type AnalyticsReadInput,
} from "./analytics-read.ts";

const AT = "2026-08-16T00:00:00.000Z";

const fullInput = (): AnalyticsReadInput => ({
  configured: true,
  generatedAt: AT,
  inventory: {
    valuation: { skus: 120, units: 3400, atCost: 50000, atPrice: 90000 },
    deadStock: { count: 7, units: 210 },
  },
  lowStock: { lowCount: 12, outCount: 4 },
  lifetimeSales: { totalUnits: 8800, totalRevenue: 220000, distinctProducts: 95 },
  catalog: {
    totalProducts: 130,
    activeChannels: 3,
    inventoryUnits: 3400,
    missingImages: 10,
    missingBarcode: 22,
    missingCategory: 5,
    missingPrice: 1,
    missingDescription: 40,
    missingKeywords: 55,
    needsMapping: 8,
  },
});

// ── Metric helpers ───────────────────────────────────────────────────────────
test("available / unknown / fromNullable build the right metric shapes", () => {
  assert.deepEqual(available(5), { status: "available", value: 5 });
  assert.deepEqual(unknown<number>(), { status: "unknown", value: null });
  assert.deepEqual(fromNullable(0), { status: "available", value: 0 }, "zero is a real value, not unknown");
  assert.deepEqual(fromNullable(null), { status: "unknown", value: null });
  assert.deepEqual(fromNullable(undefined), { status: "unknown", value: null });
});

// ── Honest UNKNOWN: windowed sales + growth are NEVER fabricated ──────────────
test("time-windowed sales and growth are ALWAYS unknown, even with full input", () => {
  const s = buildAnalyticsSnapshot(fullInput()).sales;
  for (const w of [s.today, s.yesterday, s.week, s.month]) {
    assert.equal(w.units.status, "unknown");
    assert.equal(w.revenue.status, "unknown");
    assert.equal(w.units.value, null);
  }
  assert.equal(s.growthPct.status, "unknown");
});

test("lifetime sales ARE honest when the source is present", () => {
  const s = buildAnalyticsSnapshot(fullInput()).sales;
  assert.deepEqual(s.lifetime.units, { status: "available", value: 8800 });
  assert.deepEqual(s.lifetime.revenue, { status: "available", value: 220000 });
  assert.deepEqual(s.lifetime.distinctProducts, { status: "available", value: 95 });
});

// ── Inventory ────────────────────────────────────────────────────────────────
test("inventory view maps valuation, dead stock, low/out and value", () => {
  const inv = buildAnalyticsSnapshot(fullInput()).inventory;
  assert.equal(inv.totalSkus.value, 120);
  assert.equal(inv.totalUnits.value, 3400);
  assert.equal(inv.lowStock.value, 12);
  assert.equal(inv.outOfStock.value, 4);
  assert.equal(inv.deadStock.value, 7);
  assert.equal(inv.deadStockUnits.value, 210);
  assert.equal(inv.value.atCost.value, 50000);
  assert.equal(inv.value.atPrice.value, 90000);
  assert.equal(inv.fastMoving.status, "unknown", "fast-moving has no velocity source");
});

// ── Catalog quality ──────────────────────────────────────────────────────────
test("catalog quality maps cheap counts; needsAi stays unknown (heavy classifier)", () => {
  const q = buildAnalyticsSnapshot(fullInput()).catalogQuality;
  assert.equal(q.missingImages.value, 10);
  assert.equal(q.missingBarcode.value, 22);
  assert.equal(q.missingCategory.value, 5);
  assert.equal(q.missingPrice.value, 1);
  assert.equal(q.missingDescription.value, 40);
  assert.equal(q.missingKeywords.value, 55);
  assert.equal(q.needsMapping.value, 8);
  assert.equal(q.needsAi.status, "unknown");
});

test("nullable catalog counts degrade to unknown, not zero", () => {
  const input = fullInput();
  input.catalog!.missingDescription = null;
  input.catalog!.missingKeywords = null;
  input.catalog!.needsMapping = null;
  const q = buildAnalyticsSnapshot(input).catalogQuality;
  assert.equal(q.missingDescription.status, "unknown");
  assert.equal(q.missingKeywords.status, "unknown");
  assert.equal(q.needsMapping.status, "unknown");
});

// ── KPI header ───────────────────────────────────────────────────────────────
test("kpi header reuses honest values; sales + orders stay unknown", () => {
  const kpi = buildAnalyticsSnapshot(fullInput()).kpi;
  assert.equal(kpi.totalProducts.value, 130);
  assert.equal(kpi.activeChannels.value, 3);
  assert.equal(kpi.inventoryUnits.value, 3400);
  assert.equal(kpi.inventoryValueAtPrice.value, 90000);
  assert.equal(kpi.todaySales.units.status, "unknown");
  assert.equal(kpi.monthSales.revenue.status, "unknown");
  assert.equal(kpi.orders.status, "unknown");
});

// ── Missing sections → everything degrades to unknown (never fabricated) ──────
test("empty input degrades every metric to unknown, configured=false", () => {
  const snap = buildAnalyticsSnapshot({ configured: false, generatedAt: AT });
  assert.equal(snap.configured, false);
  assert.equal(snap.generatedAt, AT);
  assert.equal(snap.inventory.totalUnits.status, "unknown");
  assert.equal(snap.inventory.value.atPrice.status, "unknown");
  assert.equal(snap.catalogQuality.missingImages.status, "unknown");
  assert.equal(snap.sales.lifetime.units.status, "unknown");
  assert.equal(snap.kpi.totalProducts.status, "unknown");
});

// ── Determinism ──────────────────────────────────────────────────────────────
test("same input → identical snapshot (pure/deterministic)", () => {
  assert.deepEqual(buildAnalyticsSnapshot(fullInput()), buildAnalyticsSnapshot(fullInput()));
});
