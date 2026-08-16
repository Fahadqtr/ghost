// OPS.1 — Operations Center composer unit tests (pure). Aggregation, health
// cards, daily summary, channel health, alerts, quick-action links, product
// health, and reason-message drift vs the readiness source of truth.
// node --conditions=react-server --experimental-strip-types --test lib/operations/ops-center.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOperationsCenter,
  buildHealthCards,
  buildDailySummary,
  buildChannelHealth,
  buildAlerts,
  buildQuickActions,
  productHealthTone,
  worst,
  REASON_MISSING_IMAGE,
  REASON_MISSING_BARCODE,
  REASON_MISSING_DESCRIPTION,
  ROUTES,
  type OpsCenterInput,
} from "./ops-center.ts";
import { READINESS_MESSAGES } from "./readiness/readiness.ts";

function input(over: Partial<OpsCenterInput> = {}): OpsCenterInput {
  return {
    kpis: { totalProducts: 100, needsImage: 0, needsReview: 0, ready: 100, readinessAverage: 95 },
    overview: {
      shopify: { available: true, published: 90, missing: 0, different: 0, reviewRequired: 0, stale: false },
      puresoul: { available: true, published: 80, missing: 0, priceDifferent: 0, reviewRequired: 0, stale: false },
      talabat: { available: true, present: 70, missing: 0, review: 0, linked: 5, stale: false },
      rafeeq: { available: true, present: 88, missing: 0, linked: 0, stale: false },
    },
    platformHealth: [
      { platform: "shopify", healthLevel: "healthy" },
      { platform: "rafeeq", healthLevel: "healthy" },
    ],
    items: [],
    ...over,
  };
}

// ── reason-message drift guard (local constants must mirror READINESS_MESSAGES) ─
test("reason message constants never drift from READINESS_MESSAGES", () => {
  assert.equal(REASON_MISSING_IMAGE, READINESS_MESSAGES.missing_image);
  assert.equal(REASON_MISSING_BARCODE, READINESS_MESSAGES.missing_barcode);
  assert.equal(REASON_MISSING_DESCRIPTION, READINESS_MESSAGES.missing_description);
});

// ── product health (reuses readiness percent) ────────────────────────────────
test("product health tone bands", () => {
  assert.equal(productHealthTone(95), "good");
  assert.equal(productHealthTone(80), "good");
  assert.equal(productHealthTone(65), "warn");
  assert.equal(productHealthTone(50), "warn");
  assert.equal(productHealthTone(30), "bad");
});

// ── health cards ─────────────────────────────────────────────────────────────
test("health cards count missing description/barcode from item reasons (no re-scan)", () => {
  const items = [
    { readinessPercent: 40, reasons: [READINESS_MESSAGES.missing_description, READINESS_MESSAGES.missing_image], needsReview: false, needsImage: true },
    { readinessPercent: 60, reasons: [READINESS_MESSAGES.missing_barcode], needsReview: false, needsImage: false },
    { readinessPercent: 95, reasons: [], needsReview: false, needsImage: false },
  ];
  const cards = buildHealthCards(input({ kpis: { totalProducts: 3, needsImage: 1, needsReview: 0, ready: 1, readinessAverage: 65 }, items }));
  const by = Object.fromEntries(cards.map((c) => [c.key, c]));
  assert.equal(by.products.value, 3);
  assert.equal(by.images_missing.value, 1);
  assert.equal(by.description_missing.value, 1);
  assert.equal(by.barcode_missing.value, 1);
  // entry-point cards carry no fabricated number
  assert.equal(by.needs_ai.value, null);
  assert.equal(by.needs_ecl.value, null);
  assert.equal(by.keywords_missing.value, null);
  // every card links to an existing workflow route
  for (const c of cards) assert.ok(typeof c.href === "string" && c.href.startsWith("/v2/"), `${c.key} links to a workflow`);
});

// ── daily summary ────────────────────────────────────────────────────────────
test("daily summary: all-clean → PASS overall", () => {
  const { domains, overall } = buildDailySummary(input());
  assert.equal(overall, "PASS");
  assert.ok(domains.every((d) => d.status === "PASS"));
  assert.deepEqual(domains.map((d) => d.domain), ["الكتالوج", "المخزون", "التوفّر", "القنوات", "الذكاء", "الأمان"]);
});

test("daily summary: heavy catalog issues → ACTION_REQUIRED; drift → availability WARNING", () => {
  const items = Array.from({ length: 40 }, () => ({ readinessPercent: 10, reasons: [READINESS_MESSAGES.missing_description], needsReview: false, needsImage: true }));
  const inp = input({
    kpis: { totalProducts: 100, needsImage: 40, needsReview: 5, ready: 20, readinessAverage: 30 },
    items,
    overview: { ...input().overview, shopify: { available: true, published: 90, missing: 0, different: 7, reviewRequired: 0, stale: false } },
  });
  const { domains, overall } = buildDailySummary(inp);
  const by = Object.fromEntries(domains.map((d) => [d.domain, d.status]));
  assert.equal(by["الكتالوج"], "ACTION_REQUIRED"); // >10% of 100
  assert.equal(by["التوفّر"], "WARNING"); // shopify.different 7
  assert.equal(overall, "ACTION_REQUIRED");
});

test("daily summary: channel needs_attention/insufficient_data → channels WARNING", () => {
  const inp = input({ platformHealth: [{ platform: "shopify", healthLevel: "insufficient_data" }] });
  const by = Object.fromEntries(buildDailySummary(inp).domains.map((d) => [d.domain, d.status]));
  assert.equal(by["القنوات"], "WARNING");
});

test("inventory/security domains are PASS (certified; no dashboard write-signal)", () => {
  const by = Object.fromEntries(buildDailySummary(input()).domains.map((d) => [d.domain, d.status]));
  assert.equal(by["المخزون"], "PASS");
  assert.equal(by["الأمان"], "PASS");
});

test("worst() precedence", () => {
  assert.equal(worst(["PASS", "WARNING", "PASS"]), "WARNING");
  assert.equal(worst(["PASS", "WARNING", "ACTION_REQUIRED"]), "ACTION_REQUIRED");
  assert.equal(worst(["PASS", "PASS"]), "PASS");
});

// ── channel health ───────────────────────────────────────────────────────────
test("channel health maps 5 storefronts; snoonu:malikas is OPERATIONALLY_BLOCKED (no reader)", () => {
  const rows = buildChannelHealth(input());
  assert.deepEqual(rows.map((r) => r.storefront), ["shopify:malikas", "snoonu:malikas", "snoonu:pure_seoul", "talabat:malikas", "rafeeq:malikas"]);
  const malikas = rows.find((r) => r.storefront === "snoonu:malikas")!;
  assert.equal(malikas.operationalBlocked, true);
  const ps = rows.find((r) => r.storefront === "snoonu:pure_seoul")!;
  assert.equal(ps.operationalBlocked, false);
  assert.equal(ps.mapped, 80);
  const talabat = rows.find((r) => r.storefront === "talabat:malikas")!;
  assert.equal(talabat.mapped, 75); // present 70 + linked 5
});

test("channel health: unavailable overview → operationalBlocked (never 'missing')", () => {
  const inp = input({ overview: { ...input().overview, shopify: { available: false, published: 0, missing: 0, different: 0, reviewRequired: 0, stale: false } } });
  const shop = buildChannelHealth(inp).find((r) => r.storefront === "shopify:malikas")!;
  assert.equal(shop.operationalBlocked, true);
});

// ── alerts ───────────────────────────────────────────────────────────────────
test("alerts: clean state still surfaces the Snoonu-session operational note only", () => {
  const alerts = buildAlerts(input());
  assert.deepEqual(alerts.map((a) => a.key), ["snoonu_session"]);
  assert.equal(alerts[0].level, "info");
});

test("alerts: images + review + per-channel missing + stale", () => {
  const inp = input({
    kpis: { totalProducts: 100, needsImage: 12, needsReview: 3, ready: 50, readinessAverage: 60 },
    snoonuMalikasReaderAvailable: true, // suppress the session note
    overview: {
      shopify: { available: true, published: 90, missing: 4, different: 0, reviewRequired: 0, stale: false },
      puresoul: { available: true, published: 80, missing: 0, priceDifferent: 0, reviewRequired: 0, stale: true },
      talabat: { available: true, present: 70, missing: 0, review: 0, linked: 0, stale: false },
      rafeeq: { available: true, present: 88, missing: 0, linked: 0, stale: false },
    },
  });
  const keys = buildAlerts(inp).map((a) => a.key);
  assert.ok(keys.includes("images"));
  assert.ok(keys.includes("review"));
  assert.ok(keys.includes("missing_Shopify"));
  assert.ok(keys.includes("stale_Pure Seoul"));
  assert.ok(!keys.includes("snoonu_session"));
  // every alert links to a workflow
  for (const a of buildAlerts(inp)) assert.ok(a.href.startsWith("/v2/"));
});

// ── quick actions ────────────────────────────────────────────────────────────
test("quick actions link only to existing workflows (no parallel screens)", () => {
  const qa = buildQuickActions();
  const allowed = new Set([ROUTES.missingProducts, ROUTES.media, ROUTES.aiEnrichment, ROUTES.barcodeCompletion, ROUTES.availabilitySync, ROUTES.rafeeqConflicts, ROUTES.operations]);
  for (const a of qa) assert.ok(allowed.has(a.href), `${a.key} → ${a.href} is an existing route`);
  assert.ok(qa.some((a) => a.key === "rafeeq"));
  assert.ok(qa.some((a) => a.key === "refresh"));
});

// ── top-level compose ────────────────────────────────────────────────────────
test("buildOperationsCenter assembles all sections + reuses readinessAverage", () => {
  const oc = buildOperationsCenter(input({ kpis: { totalProducts: 100, needsImage: 0, needsReview: 0, ready: 100, readinessAverage: 91 } }));
  assert.equal(oc.readinessAverage, 91);
  assert.ok(oc.cards.length >= 6);
  assert.equal(oc.daily.length, 6);
  assert.equal(oc.channels.length, 5);
  assert.ok(Array.isArray(oc.alerts));
  assert.ok(oc.quickActions.length >= 6);
  assert.ok(["PASS", "WARNING", "ACTION_REQUIRED"].includes(oc.overall));
});

test("composer is deterministic + side-effect free", () => {
  const a = buildOperationsCenter(input());
  const b = buildOperationsCenter(input());
  assert.deepEqual(a, b);
});
