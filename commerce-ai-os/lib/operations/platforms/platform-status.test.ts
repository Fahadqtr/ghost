// Platform Status Engine tests (Phase UI.7.1). PURE — model in, model out.
// Run: node --conditions=react-server --experimental-strip-types --test lib/operations/platforms/platform-status.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  computePlatformStatuses,
  computePlatformStatusValue,
  PLATFORM_STATUS_LABELS,
  PLATFORM_TYPES,
} from "./platform-status.ts";
import { makeProduct, presence } from "../shared/test-fixtures.ts";

test("absent from the platform: ready when publishable, missing otherwise", () => {
  assert.equal(computePlatformStatusValue(undefined, true), "ready");
  assert.equal(computePlatformStatusValue(undefined, false), "missing");
});

test("review always wins — even over published/live", () => {
  assert.equal(
    computePlatformStatusValue(presence({ linked: true, live: true, reviewRequired: true }), true),
    "review_required",
  );
});

test("linked states: drift → different, live → published, staged → ready", () => {
  assert.equal(computePlatformStatusValue(presence({ linked: true, live: true, drift: true }), false), "different");
  assert.equal(computePlatformStatusValue(presence({ linked: true, live: true }), false), "published");
  assert.equal(computePlatformStatusValue(presence({ linked: true }), false), "ready");
});

test("drift without live never reads as different — a staged copy is just ready", () => {
  assert.equal(computePlatformStatusValue(presence({ linked: true, drift: true }), false), "ready");
});

test("computePlatformStatuses: all four platforms, fixed order, Arabic labels", () => {
  const product = makeProduct({
    platforms: {
      shopify: presence({ linked: true, live: true }),
      talabat: presence({ linked: true, live: true, drift: true }),
      rafeeq: presence({ reviewRequired: true }),
    },
  });
  const statuses = computePlatformStatuses(product, true);
  assert.deepEqual(statuses.map((s) => s.platform), [...PLATFORM_TYPES]);
  assert.deepEqual(
    statuses.map((s) => s.status),
    ["published", "ready", "different", "review_required"],
    "puresoul has no snapshot → ready because the product is publishable",
  );
  for (const s of statuses) assert.equal(s.label, PLATFORM_STATUS_LABELS[s.status]);
});
