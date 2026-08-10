// CI.4 — Platform Freshness & Health (PURE) unit tests.
// Run: node --conditions=react-server --experimental-strip-types --test lib/operations/platform-health.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  AGING_FRACTION,
  buildPlatformHealth,
  computeFreshnessState,
  computePlatformHealth,
  type PlatformHealthInput,
} from "./platform-health.ts";
import type { PlatformOverview } from "./dashboard-summary.ts";
import { SHOPIFY_SNAPSHOT_STALE_MS } from "../platforms/shopify/capture-compute.ts";
import { TALABAT_SNAPSHOT_STALE_MS } from "../platforms/talabat/capture-compute.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-08-10T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

/** A healthy, fresh, present-only platform input; override per test. */
function input(over: Partial<PlatformHealthInput> = {}): PlatformHealthInput {
  return {
    platform: "shopify",
    available: true,
    degraded: false,
    lastSnapshotAt: ago(1 * HOUR),
    staleWindowMs: DAY,
    presentCount: 5,
    missingCount: 0,
    reviewCount: 0,
    differentCount: 0,
    readyCount: 0,
    unknownCount: 0,
    ...over,
  };
}

// ── freshness ─────────────────────────────────────────────────────────────────

test("freshness: no snapshot => unknown", () => {
  assert.equal(computeFreshnessState(input({ lastSnapshotAt: null }), NOW), "unknown");
});

test("freshness: degraded => unknown", () => {
  assert.equal(computeFreshnessState(input({ degraded: true }), NOW), "unknown");
});

test("freshness: unavailable => unknown", () => {
  assert.equal(computeFreshnessState(input({ available: false }), NOW), "unknown");
});

test("freshness: invalid timestamp => unknown", () => {
  assert.equal(computeFreshnessState(input({ lastSnapshotAt: "not-a-date" }), NOW), "unknown");
});

test("freshness: recent capture => fresh", () => {
  assert.equal(computeFreshnessState(input({ lastSnapshotAt: ago(1 * HOUR) }), NOW), "fresh");
});

test("freshness: past 50% of window but not stale => aging", () => {
  // window = 24h, 50% = 12h; 15h ago is aging, not yet stale.
  assert.equal(AGING_FRACTION, 0.5);
  assert.equal(computeFreshnessState(input({ lastSnapshotAt: ago(15 * HOUR) }), NOW), "aging");
});

test("freshness: exactly at 50% boundary is still fresh (strictly greater => aging)", () => {
  assert.equal(computeFreshnessState(input({ lastSnapshotAt: ago(12 * HOUR) }), NOW), "fresh");
});

test("freshness: older than window => stale", () => {
  assert.equal(computeFreshnessState(input({ lastSnapshotAt: ago(30 * HOUR) }), NOW), "stale");
});

test("freshness: deterministic — same input + injected now => same result", () => {
  const i = input({ lastSnapshotAt: ago(15 * HOUR) });
  assert.equal(computeFreshnessState(i, NOW), computeFreshnessState(i, NOW));
});

test("freshness: per-platform windows differ (24h stale vs 7d fresh at 2 days)", () => {
  const twoDays = 2 * DAY;
  assert.equal(
    computeFreshnessState(input({ lastSnapshotAt: ago(twoDays), staleWindowMs: SHOPIFY_SNAPSHOT_STALE_MS }), NOW),
    "stale",
  );
  assert.equal(
    computeFreshnessState(input({ lastSnapshotAt: ago(twoDays), staleWindowMs: TALABAT_SNAPSHOT_STALE_MS }), NOW),
    "fresh",
  );
});

// ── health level ──────────────────────────────────────────────────────────────

test("health: degraded => insufficient_data + degraded_read", () => {
  const h = computePlatformHealth(input({ degraded: true, presentCount: 9 }), NOW);
  assert.equal(h.healthLevel, "insufficient_data");
  assert.deepEqual(h.reasons, ["degraded_read"]);
});

test("health: unavailable => insufficient_data + degraded_read", () => {
  const h = computePlatformHealth(input({ available: false, presentCount: 9 }), NOW);
  assert.equal(h.healthLevel, "insufficient_data");
  assert.deepEqual(h.reasons, ["degraded_read"]);
});

test("health: knownCount=0 => insufficient_data + low_coverage", () => {
  const h = computePlatformHealth(input({ presentCount: 0, unknownCount: 20 }), NOW);
  assert.equal(h.knownCount, 0);
  assert.equal(h.healthLevel, "insufficient_data");
  assert.deepEqual(h.reasons, ["low_coverage"]);
});

test("health: snapshot source with no lastSnapshotAt => insufficient_data + no_snapshot", () => {
  const h = computePlatformHealth(input({ lastSnapshotAt: null, presentCount: 3 }), NOW);
  assert.equal(h.healthLevel, "insufficient_data");
  assert.deepEqual(h.reasons, ["no_snapshot"]);
});

test("health: missing => needs_attention + has_missing", () => {
  const h = computePlatformHealth(input({ missingCount: 2 }), NOW);
  assert.equal(h.healthLevel, "needs_attention");
  assert.ok(h.reasons.includes("has_missing"));
});

test("health: review => needs_attention + has_review", () => {
  const h = computePlatformHealth(input({ reviewCount: 1 }), NOW);
  assert.equal(h.healthLevel, "needs_attention");
  assert.ok(h.reasons.includes("has_review"));
});

test("health: different => needs_attention + has_drift", () => {
  const h = computePlatformHealth(input({ differentCount: 4 }), NOW);
  assert.equal(h.healthLevel, "needs_attention");
  assert.ok(h.reasons.includes("has_drift"));
});

test("health: ready => needs_attention + has_ready_not_live", () => {
  const h = computePlatformHealth(input({ readyCount: 3 }), NOW);
  assert.equal(h.healthLevel, "needs_attention");
  assert.ok(h.reasons.includes("has_ready_not_live"));
});

test("health: stale => needs_attention + stale_data (counts unchanged)", () => {
  const h = computePlatformHealth(input({ presentCount: 7, lastSnapshotAt: ago(30 * HOUR) }), NOW);
  assert.equal(h.freshnessState, "stale");
  assert.equal(h.healthLevel, "needs_attention");
  assert.ok(h.reasons.includes("stale_data"));
  assert.equal(h.presentCount, 7); // stale never mutates counts
  assert.equal(h.missingCount, 0);
});

test("health: aging only => healthy + aging_data", () => {
  const h = computePlatformHealth(input({ presentCount: 6, lastSnapshotAt: ago(15 * HOUR) }), NOW);
  assert.equal(h.freshnessState, "aging");
  assert.equal(h.healthLevel, "healthy");
  assert.deepEqual(h.reasons, ["aging_data"]);
});

test("health: unknownCount alone does NOT hurt health", () => {
  const h = computePlatformHealth(input({ presentCount: 3, unknownCount: 500 }), NOW);
  assert.equal(h.healthLevel, "healthy");
  assert.deepEqual(h.reasons, []); // unknown ≠ missing, never an attention trigger
});

test("health: clean, fresh, present-only => healthy, no reasons", () => {
  const h = computePlatformHealth(input({ presentCount: 10 }), NOW);
  assert.equal(h.healthLevel, "healthy");
  assert.deepEqual(h.reasons, []);
});

test("health: healthScore is ALWAYS null (CI.4 v1)", () => {
  const cases = [
    input({ degraded: true }),
    input({ presentCount: 0 }),
    input({ missingCount: 5 }),
    input({ presentCount: 9, lastSnapshotAt: ago(30 * HOUR) }),
    input({ presentCount: 9, lastSnapshotAt: ago(15 * HOUR) }),
    input({ presentCount: 9 }),
  ];
  for (const c of cases) assert.equal(computePlatformHealth(c, NOW).healthScore, null);
});

// ── buildPlatformHealth (normalization from the dashboard overview) ─────────────

function overview(over: Partial<PlatformOverview> = {}): PlatformOverview {
  return {
    shopify: {
      available: true,
      published: 10,
      missing: 0,
      different: 0,
      reviewRequired: 0,
      ready: 0,
      lastCapturedAt: ago(1 * HOUR),
      stale: false,
    },
    puresoul: {
      available: true,
      published: 4,
      missing: 0,
      different: 0,
      priceDifferent: 0,
      reviewRequired: 0,
      outOfStock: 2,
      unknown: 3,
      lastCapturedAt: ago(1 * HOUR),
      stale: false,
    },
    talabat: {
      available: true,
      present: 5,
      missing: 0,
      review: 0,
      linked: 0,
      unknown: 1,
      lastCapturedAt: ago(1 * HOUR),
      stale: false,
    },
    rafeeq: {
      available: true,
      present: 5,
      missing: 0,
      linked: 0,
      unknown: 1,
      lastCapturedAt: ago(1 * HOUR),
      stale: false,
    },
    ...over,
  };
}

test("build: fixed UI order — PureSoul, Shopify, Talabat, Rafeeq", () => {
  const rows = buildPlatformHealth(overview(), 20, { puresoul: false, talabat: false, rafeeq: false }, NOW);
  assert.deepEqual(
    rows.map((r) => r.platform),
    ["puresoul", "shopify", "talabat", "rafeeq"],
  );
});

test("build: Shopify unknownCount is DERIVED as max(0, total − knownSum)", () => {
  const rows = buildPlatformHealth(
    overview({
      shopify: {
        available: true,
        published: 6,
        missing: 1,
        different: 1,
        reviewRequired: 1,
        ready: 1,
        lastCapturedAt: ago(1 * HOUR),
        stale: false,
      },
    }),
    20,
    { puresoul: false, talabat: false, rafeeq: false },
    NOW,
  );
  const shopify = rows.find((r) => r.platform === "shopify")!;
  assert.equal(shopify.knownCount, 10); // 6+1+1+1+1
  assert.equal(shopify.unknownCount, 10); // 20 − 10
});

test("build: Shopify unknown never negative (knownSum > total)", () => {
  const rows = buildPlatformHealth(overview(), 3, { puresoul: false, talabat: false, rafeeq: false }, NOW);
  const shopify = rows.find((r) => r.platform === "shopify")!;
  assert.equal(shopify.unknownCount, 0); // clamped, never negative
});

test("build: PureSoul out-of-stock counts as present (listed, not a problem)", () => {
  const rows = buildPlatformHealth(overview(), 20, { puresoul: false, talabat: false, rafeeq: false }, NOW);
  const ps = rows.find((r) => r.platform === "puresoul")!;
  assert.equal(ps.presentCount, 6); // published 4 + outOfStock 2
  assert.equal(ps.healthLevel, "healthy");
  assert.deepEqual(ps.reasons, []);
});

test("build: PureSoul degraded flag => insufficient_data (never missing)", () => {
  const rows = buildPlatformHealth(overview(), 20, { puresoul: true, talabat: false, rafeeq: false }, NOW);
  const ps = rows.find((r) => r.platform === "puresoul")!;
  assert.equal(ps.healthLevel, "insufficient_data");
  assert.deepEqual(ps.reasons, ["degraded_read"]);
  assert.equal(ps.missingCount, 0);
});

test("build: Talabat/Rafeeq linked maps to ready (staged, not live)", () => {
  const rows = buildPlatformHealth(
    overview({
      talabat: { available: true, present: 2, missing: 0, review: 0, linked: 3, unknown: 0, lastCapturedAt: ago(1 * HOUR), stale: false },
      rafeeq: { available: true, present: 2, missing: 0, linked: 4, unknown: 0, lastCapturedAt: ago(1 * HOUR), stale: false },
    }),
    20,
    { puresoul: false, talabat: false, rafeeq: false },
    NOW,
  );
  const tb = rows.find((r) => r.platform === "talabat")!;
  const rf = rows.find((r) => r.platform === "rafeeq")!;
  assert.equal(tb.readyCount, 3);
  assert.equal(rf.readyCount, 4);
  assert.ok(tb.reasons.includes("has_ready_not_live"));
  assert.ok(rf.reasons.includes("has_ready_not_live"));
});

test("build: per-platform windows — Shopify (24h) stale vs Talabat (7d) fresh at 2 days", () => {
  const twoDays = 2 * DAY;
  const rows = buildPlatformHealth(
    overview({
      shopify: { available: true, published: 10, missing: 0, different: 0, reviewRequired: 0, ready: 0, lastCapturedAt: ago(twoDays), stale: true },
      talabat: { available: true, present: 5, missing: 0, review: 0, linked: 0, unknown: 0, lastCapturedAt: ago(twoDays), stale: false },
    }),
    20,
    { puresoul: false, talabat: false, rafeeq: false },
    NOW,
  );
  assert.equal(rows.find((r) => r.platform === "shopify")!.freshnessState, "stale");
  assert.equal(rows.find((r) => r.platform === "talabat")!.freshnessState, "fresh");
});

test("build: every row carries a null healthScore and a label", () => {
  const rows = buildPlatformHealth(overview(), 20, { puresoul: false, talabat: false, rafeeq: false }, NOW);
  for (const r of rows) {
    assert.equal(r.healthScore, null);
    assert.ok(r.label.length > 0);
  }
});
