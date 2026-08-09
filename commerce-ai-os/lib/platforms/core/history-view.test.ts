// Phase UI.9.4 — platform history view helpers (pure): labels, formatting,
// bounded pagination. No clock, no I/O.
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/core/history-view.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import type { PlatformHistoryEntry } from "./history.ts";
import {
  changeTypeLabel,
  fieldLabel,
  formatDelta,
  formatSnapshotDate,
  formatValue,
  paginateHistory,
  platformLabel,
} from "./history-view.ts";

test("platformLabel maps known ids, falls back to the id", () => {
  assert.equal(platformLabel("puresoul"), "PureSoul");
  assert.equal(platformLabel("pure_seoul"), "PureSoul");
  assert.equal(platformLabel("shopify"), "Shopify");
  assert.equal(platformLabel("future_x"), "future_x");
});

test("field + change-type labels are fixed Arabic", () => {
  assert.equal(fieldLabel("price"), "السعر");
  assert.equal(fieldLabel("availability"), "التوفّر");
  assert.equal(changeTypeLabel("created"), "أول لقطة");
  assert.equal(changeTypeLabel("changed"), "تحديث");
});

test("formatValue handles null/blank/number", () => {
  assert.equal(formatValue(null), "—");
  assert.equal(formatValue(""), "—");
  assert.equal(formatValue(" "), "—");
  assert.equal(formatValue(90), "90");
  assert.equal(formatValue("published"), "published");
});

test("formatDelta: created shows value only; changed shows before ← after", () => {
  assert.equal(formatDelta({ field: "price", before: null, after: 100 }), "100");
  assert.equal(formatDelta({ field: "price", before: 100, after: 90 }), "100 ← 90");
});

test("formatSnapshotDate parses ISO prefix only (no clock)", () => {
  assert.equal(formatSnapshotDate("2026-08-09T13:00:00Z"), "9 أغسطس 2026");
  assert.equal(formatSnapshotDate("not-a-date"), "—");
  assert.equal(formatSnapshotDate(null), "—");
});

function entry(i: number): PlatformHistoryEntry {
  return {
    productId: "p1",
    platform: "puresoul",
    changeType: "changed",
    fields: [],
    metadataChanged: false,
    capturedAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    snapshotVersion: 1,
  };
}

test("paginateHistory clamps size and windows correctly", () => {
  const entries = Array.from({ length: 25 }, (_, i) => entry(i));
  const p1 = paginateHistory(entries, 1, 20);
  assert.equal(p1.items.length, 20);
  assert.equal(p1.total, 25);
  assert.equal(p1.hasMore, true);
  const p2 = paginateHistory(entries, 2, 20);
  assert.equal(p2.items.length, 5);
  assert.equal(p2.hasMore, false);
});

test("paginateHistory: out-of-range page → empty window, never throws", () => {
  const entries = [entry(0), entry(1)];
  const p = paginateHistory(entries, 99, 20);
  assert.deepEqual(p.items, []);
  assert.equal(p.hasMore, false);
});

test("paginateHistory: pageSize clamped to [1,100]", () => {
  const entries = Array.from({ length: 5 }, (_, i) => entry(i));
  assert.equal(paginateHistory(entries, 1, 0).pageSize, 20); // 0 → default
  assert.equal(paginateHistory(entries, 1, 9999).pageSize, 100); // clamp max
});
