// Tests for the pure engagement math behind the /social performance report.
// Run: node --experimental-strip-types --test lib/social/insights-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { engagementScore, engagementRate, ratePct, summarizeInsights, EMPTY_STATS, type PostStats } from "./insights-compute.ts";

const stats = (over: Partial<PostStats>): PostStats => ({ ...EMPTY_STATS, ...over });

test("engagementScore weights saves/shares above likes", () => {
  assert.equal(engagementScore(stats({ likes: 10 })), 10);
  assert.equal(engagementScore(stats({ comments: 5 })), 10);
  assert.equal(engagementScore(stats({ saved: 2, shares: 1 })), 9);
  assert.equal(engagementScore(EMPTY_STATS), 0);
});

test("engagementRate divides interactions by reach, null without reach", () => {
  assert.equal(engagementRate(stats({ likes: 8, comments: 2, reach: 100 })), 0.1);
  assert.equal(engagementRate(stats({ likes: 8 })), null);
  assert.equal(ratePct(0.1), "10.0%");
  assert.equal(ratePct(null), "—");
});

test("summarizeInsights totals every metric and picks the strongest post", () => {
  const { totals, bestId, avgReach } = summarizeInsights([
    { id: "a", stats: stats({ likes: 10, reach: 100, views: 150 }) },
    { id: "b", stats: stats({ likes: 2, saved: 5, reach: 60, views: 80 }) }, // score 17 → best
  ]);
  assert.deepEqual(totals, { likes: 12, comments: 0, reach: 160, views: 230, saved: 5, shares: 0 });
  assert.equal(bestId, "b");
  assert.equal(avgReach, 80);
});

test("summarizeInsights on an empty report", () => {
  const { totals, bestId, avgReach } = summarizeInsights([]);
  assert.deepEqual(totals, EMPTY_STATS);
  assert.equal(bestId, null);
  assert.equal(avgReach, 0);
});
