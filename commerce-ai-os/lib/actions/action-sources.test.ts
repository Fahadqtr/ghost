// AI.1 — source adapter tests (§11 Registry/Grouping via real translations).
// PURE — synthetic reader-shaped inputs, no DB/network. Proves each adapter
// TRANSLATES already-computed reader output and honestly drops UNKNOWN signals.
// node --conditions=react-server --experimental-strip-types --test lib/actions/action-sources.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { actionsFromAi, actionsFromAnalytics, actionsFromHealth, actionsFromMedia } from "./action-sources.ts";
import { buildActionCenter } from "./action-model.ts";
import type { AnalyticsSnapshot } from "@/lib/analytics/analytics-read";
import type { HealthCenterModel } from "@/lib/operations/health/health-center";
import type { MediaCenterView } from "@/lib/operations/media/media-center.server";
import type { AiCenterModel } from "@/lib/operations/ai/ai-center";

const avail = (value: number) => ({ status: "available" as const, value });
const unknown = () => ({ status: "unknown" as const, value: null });

// ── OPS Health → HEALTH_ALERT ─────────────────────────────────────────────────
test("health findings become HEALTH_ALERT with severity mapping + href passthrough", () => {
  const model = {
    findings: [
      { domain: "channels", severity: "action", reason: "قنوات معطّلة", count: 3, workflow: "channels", href: "/v2/operations/channels" },
      { domain: "media", severity: "warning", reason: "صور ناقصة", count: null, workflow: "media", href: "/v2/operations/media" },
    ],
  } as unknown as HealthCenterModel;

  const actions = actionsFromHealth(model);
  assert.equal(actions.length, 2);
  assert.ok(actions.every((a) => a.type === "HEALTH_ALERT" && a.source === "ops_health"));
  const chan = actions[0]!;
  assert.equal(chan.severity, "critical"); // "action" → critical
  assert.equal(chan.workflowHref, "/v2/operations/channels");
  assert.ok(chan.evidence.some((e) => e.value === "3"));
  assert.equal(actions[1]!.severity, "warning"); // "warning" → warning
  // null/empty safe
  assert.deepEqual(actionsFromHealth(null), []);
  assert.deepEqual(actionsFromHealth({ findings: [] } as unknown as HealthCenterModel), []);
});

// ── Analytics → typed catalog/stock actions, UNKNOWN skipped ───────────────────
test("analytics maps available non-zero metrics and DROPS unknown / zero metrics", () => {
  const snap = {
    catalogQuality: {
      missingImages: avail(12),
      missingBarcode: avail(4),
      missingDescription: unknown(), // UNKNOWN → skipped
      missingKeywords: avail(0), // zero → skipped
      missingPrice: avail(2),
      needsMapping: avail(5),
      needsAi: unknown(),
    },
    inventory: {
      lowStock: avail(7),
      outOfStock: avail(1),
      deadStock: avail(3),
    },
  } as unknown as AnalyticsSnapshot;

  const actions = actionsFromAnalytics(snap);
  const byType = new Map(actions.map((a) => [a.type, a]));
  assert.ok(byType.has("IMAGE_REQUIRED"));
  assert.ok(byType.has("BARCODE_REQUIRED"));
  assert.ok(byType.has("PRICE_REVIEW"));
  assert.ok(byType.has("MAPPING_REVIEW"));
  assert.ok(byType.has("LOW_STOCK"));
  assert.ok(byType.has("OUT_OF_STOCK"));
  assert.ok(byType.has("ARCHIVE_CANDIDATE")); // dead stock
  assert.equal(byType.has("DESCRIPTION_UPDATE"), false, "unknown metric emits nothing");
  assert.equal(byType.has("KEYWORDS_UPDATE"), false, "zero metric emits nothing");
  assert.equal(byType.get("IMAGE_REQUIRED")!.evidence[0]!.value, "12");
  // catalog-wide actions are not tied to a product
  assert.equal(byType.get("IMAGE_REQUIRED")!.entityId, null);
  assert.deepEqual(actionsFromAnalytics(null), []);
});

// ── OPS Media → per-product IMAGE_REQUIRED + IMAGE_REPLACE ─────────────────────
test("media missing[] → IMAGE_REQUIRED per product; duplicates[] → IMAGE_REPLACE", () => {
  const view = {
    missing: [
      { productId: "p1", sku: "SKU1", name: "سيروم", brandId: "b", category: "Skincare", suggestedAction: "RECOVER_SNOONU" },
      { productId: "p2", sku: null, name: null, brandId: null, category: null, suggestedAction: "UPLOAD" },
    ],
    duplicates: [{ kind: "cross_product_url", value: "http://x/a.jpg", productIds: ["p3", "p4"] }],
  } as unknown as MediaCenterView;

  const actions = actionsFromMedia(view);
  const req = actions.filter((a) => a.type === "IMAGE_REQUIRED");
  const rep = actions.filter((a) => a.type === "IMAGE_REPLACE");
  assert.equal(req.length, 2);
  assert.equal(req[0]!.entityId, "p1");
  assert.equal(req[0]!.suggestedState, "استرجاع من سنونو");
  assert.equal(req[1]!.suggestedState, "رفع صورة");
  assert.equal(rep.length, 1);
  assert.equal(rep[0]!.evidence[0]!.value, "2"); // affected products
  assert.deepEqual(actionsFromMedia(null), []);
});

// ── OPS AI → field-typed enrichment actions ───────────────────────────────────
test("ai needsGeneration rows typed by field kind; confidence follows the action", () => {
  const model = {
    needsGeneration: [
      { key: "p1::keywords_ar", productId: "p1", sku: "S1", name: "منتج", brand: "b", field: "keywords_ar", currentQuality: "MISSING", suggestionStatus: null, reason: "لا كلمات", action: "generate" },
      { key: "p2::description_en", productId: "p2", sku: null, name: null, brand: null, field: "description_en", currentQuality: "WEAK", suggestionStatus: "READY", reason: "وصف ضعيف", action: "approve" },
      { key: "p3::other", productId: "p3", sku: null, name: null, brand: null, field: null, currentQuality: null, suggestionStatus: null, reason: "مراجعة", action: "review" },
    ],
  } as unknown as AiCenterModel;

  const actions = actionsFromAi(model);
  assert.equal(actions[0]!.type, "KEYWORDS_UPDATE");
  assert.equal(actions[0]!.confidence, "high"); // action "generate"
  assert.equal(actions[1]!.type, "DESCRIPTION_UPDATE");
  assert.equal(actions[1]!.confidence, "medium"); // action "approve"
  assert.equal(actions[2]!.type, "AI_REVIEW"); // null field
  assert.deepEqual(actionsFromAi(null), []);
});

// ── integration: adapters feed the aggregate view cleanly ─────────────────────
test("adapter outputs aggregate through buildActionCenter into grouped lanes", () => {
  const health = actionsFromHealth({
    findings: [{ domain: "inventory", severity: "action", reason: "نفد", count: 1, workflow: "x", href: "/v2/operations/health" }],
  } as unknown as HealthCenterModel);
  const analytics = actionsFromAnalytics({
    catalogQuality: { missingImages: avail(3) },
    inventory: {},
  } as unknown as AnalyticsSnapshot);

  const view = buildActionCenter([...health, ...analytics], {
    sources: [
      { source: "ops_health", ok: true, count: health.length },
      { source: "analytics", ok: true, count: analytics.length },
    ],
    generatedAt: "2026-08-16T00:00:00.000Z",
  });
  assert.equal(view.summary.total, 2);
  assert.equal(view.summary.critical, 1); // the health action-required finding
  assert.ok(view.groups.some((g) => g.type === "HEALTH_ALERT"));
  assert.ok(view.groups.some((g) => g.type === "IMAGE_REQUIRED"));
});
