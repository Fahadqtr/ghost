// HOME.1 — pure composer unit tests.
// node --conditions=react-server --experimental-strip-types --test lib/home/home-model.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { buildHomeDashboard, UNKNOWN, type HomeFacts } from "./home-model.ts";

function fullFacts(): HomeFacts {
  return {
    now: "2026-08-18T08:30:00.000Z",
    ownerName: "Fahad",
    actions: { critical: 2, approvalRequired: 5, waiting: 3, completedToday: 0, total: 10, high: 4, medium: 6 },
    lifecycle: { active: 100, draft: 40, stopped: 7, ready: 12 },
    catalog: { total: 200, ready: 150, blocked: 50, needsImage: 8, needsCategory: 3, needsPrice: 1, needsBrand: 9 },
    health: { averageScore: 82, total: 200, byGrade: { Excellent: 50, Good: 90, Fair: 40, Poor: 15, Critical: 5 } },
    evidence: { total: 300, productsWithEvidence: 120, bySeverity: { CRITICAL: 5, ERROR: 20, WARNING: 100, INFO: 175 } },
    recommendations: { total: 80, productsWithRecommendations: 60, byPriority: { CRITICAL: 3, HIGH: 20, MEDIUM: 40, LOW: 17 } },
    channels: [
      { key: "shopify:malikas", label: "Shopify — Malikas", status: "سليم", mapped: 150, blocked: 10, needsReview: 2, lastExport: "2026-08-18T00:00:00Z", href: "/x" },
    ],
    exports: { eligible: 150, blocked: 50, historyAvailable: true, runs: [{ operation: "publish", status: "SUCCEEDED", finishedAt: "2026-08-18T00:00:00Z", createdCount: 1, updatedCount: 2, failedCount: 0 }], pending: 0, failed: 0, completed: 1, lastPublish: "2026-08-18T00:00:00Z" },
    ai: { needGeneration: 30, needReview: 0, readyApply: 0, providerState: "AVAILABLE", providerConfigured: true, lastSuccessAt: "2026-08-17T00:00:00Z" },
    rewards: { registeredMembers: 500, pendingReviews: 4, heartsApprovedToday: UNKNOWN, rewardsReady: 6, completedCards: 42, latestRegistrations: [{ name: "A", phone: "9745", createdAt: "2026-08-18" }] },
    analytics: {
      configured: true,
      revenue: { key: "revenue", label: "الإيراد", value: "ر.ق 1,000", available: true },
      orders: { key: "orders", label: "الطلبات", value: "—", available: false },
      averageOrder: { key: "aov", label: "متوسط الطلب", value: "—", available: false },
      inventoryValue: { key: "inventory_value", label: "قيمة المخزون", value: "ر.ق 9,000", available: true },
    },
    activity: [{ id: "e1", at: "2026-08-18T08:00:00Z", type: "catalog_enrich", sku: "SKU1", field: "keywords_ar", status: "ok" }],
    generatedAt: "2026-08-18T08:30:00.000Z",
  };
}

test("welcome derives greeting, date and platform status from certified health score", () => {
  const m = buildHomeDashboard(fullFacts());
  assert.equal(m.welcome.greeting, "صباح الخير"); // 08:30 local-of-runner; morning band
  assert.equal(m.welcome.ownerName, "Fahad");
  assert.ok(m.welcome.dateLabel.length > 0);
  assert.equal(m.welcome.platformStatus.label, "جيد"); // 82 ⇒ Good
  assert.equal(m.welcome.platformStatus.tone, "good");
});

test("today's overview maps the four certified counts", () => {
  const m = buildHomeDashboard(fullFacts());
  const byKey = Object.fromEntries(m.overview.cards.map((c) => [c.key, c.value]));
  assert.equal(byKey.critical_actions, 2);
  assert.equal(byKey.need_approval, 5);
  assert.equal(byKey.ready_activation, 12);
  assert.equal(byKey.platform_health, 82);
});

test("action center summary uses lanes + severity axis (high=warning, medium=info)", () => {
  const m = buildHomeDashboard(fullFacts());
  const byKey = Object.fromEntries(m.actionCenter.cards.map((c) => [c.key, c.value]));
  assert.equal(byKey.critical, 2);
  assert.equal(byKey.high, 4);
  assert.equal(byKey.medium, 6);
  assert.equal(byKey.waiting, 3);
  assert.equal(byKey.completed_today, 0);
});

test("catalog overview maps lifecycle + field gaps + readiness baseline", () => {
  const m = buildHomeDashboard(fullFacts());
  const byKey = Object.fromEntries(m.catalog.cards.map((c) => [c.key, c.value]));
  assert.equal(byKey.products, 200);
  assert.equal(byKey.active, 100);
  assert.equal(byKey.draft, 40);
  assert.equal(byKey.stopped, 7);
  assert.equal(byKey.ready, 150);
  assert.equal(byKey.blocked, 50);
  assert.equal(byKey.needs_image, 8);
  assert.equal(byKey.needs_category, 3);
  assert.equal(byKey.needs_price, 1);
  assert.equal(byKey.needs_brand, 9);
});

test("intelligence bars follow the certified grade/severity/priority order", () => {
  const m = buildHomeDashboard(fullFacts());
  assert.deepEqual(m.intelligence.healthDistribution.map((r) => r.grade), ["Excellent", "Good", "Fair", "Poor", "Critical"]);
  assert.deepEqual(m.intelligence.evidenceBySeverity.map((r) => r.severity), ["CRITICAL", "ERROR", "WARNING", "INFO"]);
  assert.deepEqual(m.intelligence.recommendationsByPriority.map((r) => r.priority), ["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
  assert.equal(m.intelligence.averageScore, 82);
});

test("ai provider label maps the certified diagnostics state", () => {
  assert.equal(buildHomeDashboard(fullFacts()).aiOverview.provider.label, "متصل");
  const degraded = fullFacts(); degraded.ai!.providerState = "DEGRADED";
  assert.equal(buildHomeDashboard(degraded).aiOverview.provider.label, "متذبذب");
  const off = fullFacts(); off.ai!.providerState = "UNAVAILABLE";
  assert.equal(buildHomeDashboard(off).aiOverview.provider.label, "غير مهيأ");
});

test("rewards Hearts-Approved-Today stays UNKNOWN (no certified loader — never fabricated)", () => {
  const m = buildHomeDashboard(fullFacts());
  const hearts = m.rewards.cards.find((c) => c.key === "hearts_today");
  assert.equal(hearts?.value, UNKNOWN);
  assert.equal(m.rewards.latestRegistrations.length, 1);
});

test("analytics passes pre-formatted stats through (unknown ⇒ em dash, never fabricated)", () => {
  const m = buildHomeDashboard(fullFacts());
  assert.equal(m.analytics.cards.length, 4);
  const orders = m.analytics.cards.find((c) => c.key === "orders");
  assert.equal(orders?.value, "—");
  assert.equal(orders?.available, false);
});

test("recent activity + export runs + channels pass through", () => {
  const m = buildHomeDashboard(fullFacts());
  assert.equal(m.activity.events.length, 1);
  assert.equal(m.exportOverview.runs.length, 1);
  assert.equal(m.channelHealth.channels.length, 1);
  assert.equal(m.channelHealth.channels[0].key, "shopify:malikas");
});

test("quick actions expose the 7 required entry points", () => {
  const m = buildHomeDashboard(fullFacts());
  assert.deepEqual(
    m.quickActions.map((a) => a.key),
    ["add_product", "export", "catalog", "actions", "operations", "rewards", "analytics"],
  );
});

test("degraded (all-null) facts never throw and surface UNKNOWN, not fabricated zeros", () => {
  const empty: HomeFacts = {
    now: "2026-08-18T20:00:00.000Z", ownerName: "Fahad",
    actions: null, lifecycle: null, catalog: null, health: null, evidence: null,
    recommendations: null, channels: null, exports: null, ai: null, rewards: null,
    analytics: null, activity: null, generatedAt: null,
  };
  const m = buildHomeDashboard(empty);
  assert.equal(m.welcome.platformStatus.label, "غير معروف");
  assert.equal(m.overview.cards.find((c) => c.key === "platform_health")?.value, UNKNOWN);
  assert.equal(m.actionCenter.available, false);
  assert.equal(m.catalog.available, false);
  assert.equal(m.channelHealth.channels.length, 0);
  assert.equal(m.intelligence.available, false);
  assert.equal(m.analytics.cards.length, 0);
  assert.equal(m.activity.events.length, 0);
  // quick actions are static — always present even when every source is down.
  assert.equal(m.quickActions.length, 7);
});

test("UNKNOWN counts pass through untouched (never coerced to 0)", () => {
  const f = fullFacts();
  f.actions = { critical: UNKNOWN, approvalRequired: UNKNOWN, waiting: UNKNOWN, completedToday: UNKNOWN, total: UNKNOWN, high: UNKNOWN, medium: UNKNOWN };
  const m = buildHomeDashboard(f);
  for (const c of m.actionCenter.cards) assert.equal(c.value, UNKNOWN);
});
