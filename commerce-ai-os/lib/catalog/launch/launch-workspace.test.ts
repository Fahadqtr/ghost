// WAVE.1A — Launch Campaign Workspace composer unit tests.
// node --conditions=react-server --experimental-strip-types --test lib/catalog/launch/launch-workspace.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { buildLaunchWorkspace, productEditorHref, type WorkItemInput } from "./launch-workspace.ts";
import { buildLaunchReadiness, UNKNOWN } from "../../home/home-model.ts";
import { READINESS_MESSAGES } from "../../operations/readiness/readiness.ts";

const vm = () =>
  buildLaunchReadiness({
    exportReady: 150, blocked: 50, channels: [], criticalBlockers: 2,
    missingPrice: 5, missingImage: 8, missingCategory: 3, variantProblems: 4,
    needsReview: 2, lifecycleBlocked: 7, availabilityBlocked: 9,
  });

const item = (over: Partial<WorkItemInput>): WorkItemInput => ({
  id: "p", sku: "mk1", name: "P", imageUrl: null, reasons: [], needsImage: false,
  needsReview: false, readinessPercent: 50, readinessStatus: "not_ready",
  channelMissing: { shopify: false, talabat: false, snoonu: false, rafeeq: false },
  ...over,
});

function model() {
  return buildLaunchWorkspace({
    launchReadiness: vm(),
    generatedAt: "2026-08-18T08:00:00.000Z",
    items: [
      item({ id: "img", sku: "mk-img", needsImage: true, readinessPercent: 30 }),
      item({ id: "price", sku: "mk-price", reasons: [READINESS_MESSAGES.missing_price], readinessPercent: 40 }),
      item({ id: "var", sku: "mk-var", reasons: [READINESS_MESSAGES.missing_variants], readinessPercent: 55 }),
      item({ id: "cat", sku: "mk-cat", reasons: [READINESS_MESSAGES.missing_category], readinessPercent: 60, channelMissing: { shopify: true, talabat: false, snoonu: false, rafeeq: false } }),
      item({ id: "brand", sku: "mk-brand", reasons: [READINESS_MESSAGES.missing_brand], readinessPercent: 80 }),
      item({ id: "done", sku: "mk-done", reasons: [], readinessPercent: 100, readinessStatus: "ready" }),
    ],
  });
}

test("completed products are excluded from the work queue", () => {
  const m = model();
  assert.equal(m.rows.some((r) => r.id === "done"), false);
  assert.equal(m.rows.length, 5);
  assert.equal(m.completionSummary.inQueue, 5);
});

test("blocker classification + wave/priority follow the certified reasons", () => {
  const m = model();
  const byId = Object.fromEntries(m.rows.map((r) => [r.id, r]));
  assert.equal(byId.img.blockerKey, "image");
  assert.equal(byId.img.wave, 1);
  assert.equal(byId.img.priority, "high");
  assert.equal(byId.price.blockerKey, "price");
  assert.equal(byId.price.wave, 1);
  assert.equal(byId.var.blockerKey, "variants");
  assert.equal(byId.var.wave, 1);
  assert.equal(byId.cat.blockerKey, "category");
  assert.equal(byId.cat.wave, 2);
  assert.equal(byId.cat.priority, "medium");
  assert.equal(byId.brand.blockerKey, "brand");
  assert.equal(byId.brand.wave, 3);
  assert.equal(byId.brand.priority, "low");
});

test("blocker message is the certified READINESS_MESSAGES string", () => {
  const m = model();
  const byId = Object.fromEntries(m.rows.map((r) => [r.id, r]));
  assert.equal(byId.price.blocker, READINESS_MESSAGES.missing_price);
  assert.equal(byId.cat.blocker, READINESS_MESSAGES.missing_category);
});

test("Wave 1 queue counts exactly the certified critical blockers", () => {
  const m = model();
  assert.equal(m.wave1Queue.missingImages, 1);
  assert.equal(m.wave1Queue.missingPrices, 1);
  assert.equal(m.wave1Queue.variantProblems, 1);
  assert.equal(m.wave1Queue.total, 3); // img + price + var
});

test("each row deep-links to the EXISTING product editor", () => {
  const m = model();
  for (const r of m.rows) assert.equal(r.href, productEditorHref(r.id));
  assert.equal(productEditorHref("abc"), "/v2/catalog/abc");
});

test("campaign progress + completion summary reuse the Launch Readiness VM", () => {
  const m = model();
  assert.equal(m.campaignProgress.readinessPct, 75); // 150/(150+50)
  assert.equal(m.campaignProgress.productsRemaining, 50);
  assert.equal(m.campaignProgress.completedToday, UNKNOWN); // no certified source
  assert.equal(m.completionSummary.completed, 150);
  assert.equal(m.completionSummary.remaining, 50);
});

test("rows are ordered by wave then lowest readiness first", () => {
  const waves = model().rows.map((r) => r.wave);
  const sorted = [...waves].sort((a, b) => a - b);
  assert.deepEqual(waves, sorted, "waves ascending");
  // within wave 1, lowest readiness (img 30) precedes price 40 precedes var 55
  const w1 = model().rows.filter((r) => r.wave === 1).map((r) => r.id);
  assert.deepEqual(w1, ["img", "price", "var"]);
});

test("degraded facts never throw and surface an empty, honest workspace", () => {
  const m = buildLaunchWorkspace({ launchReadiness: buildLaunchReadiness(null), items: [], generatedAt: null });
  assert.equal(m.rows.length, 0);
  assert.equal(m.campaignProgress.readinessPct, UNKNOWN);
  assert.equal(m.wave1Queue.total, 0);
  assert.equal(m.completionSummary.inQueue, 0);
});
