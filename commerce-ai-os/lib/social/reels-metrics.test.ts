// Tests for per-format Reels metrics + the Sunday cut rule.
// Run: node --experimental-strip-types --test lib/social/reels-metrics.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { formatWeeklyAverages, formatsToCut, type ReelMetricRow } from "./reels-metrics.ts";

test("weekly averages group by (week, format)", () => {
  const rows: ReelMetricRow[] = [
    { format: "review", week: "W1", views: 100 },
    { format: "review", week: "W1", views: 200 },
    { format: "asmr", week: "W1", views: 50 },
  ];
  const avg = formatWeeklyAverages(rows);
  const review = avg.find((a) => a.format === "review" && a.week === "W1")!;
  assert.equal(review.avgViews, 150);
  assert.equal(review.count, 2);
});

test("cuts a format under 50% of the weekly median for 2 straight weeks", () => {
  // Each week: entertainment & review ~1000 (median ~1000), asmr ~200 (<50%).
  const rows: ReelMetricRow[] = [
    { format: "entertainment", week: "W1", views: 1000 },
    { format: "review", week: "W1", views: 1000 },
    { format: "asmr", week: "W1", views: 200 },
    { format: "entertainment", week: "W2", views: 1200 },
    { format: "review", week: "W2", views: 900 },
    { format: "asmr", week: "W2", views: 150 },
  ];
  assert.deepEqual(formatsToCut(rows), ["asmr"]);
});

test("does NOT cut when the format was weak only ONE of the two weeks", () => {
  const rows: ReelMetricRow[] = [
    { format: "entertainment", week: "W1", views: 1000 },
    { format: "review", week: "W1", views: 1000 },
    { format: "asmr", week: "W1", views: 900 }, // healthy W1
    { format: "entertainment", week: "W2", views: 1200 },
    { format: "review", week: "W2", views: 900 },
    { format: "asmr", week: "W2", views: 150 }, // weak only W2
  ];
  assert.deepEqual(formatsToCut(rows), []);
});

test("returns [] with fewer than 2 weeks of data", () => {
  const rows: ReelMetricRow[] = [
    { format: "entertainment", week: "W1", views: 1000 },
    { format: "asmr", week: "W1", views: 100 },
  ];
  assert.deepEqual(formatsToCut(rows), []);
});
