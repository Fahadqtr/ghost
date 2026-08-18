// AI.1 / CAT.1C — source adapter tests. PURE — synthetic reader-shaped inputs,
// no DB/network. Proves each surviving adapter TRANSLATES already-computed reader
// output and honestly drops UNKNOWN signals. CAT.1C retired the overlapping
// catalog-quality projections (media-missing, AI needsGeneration, analytics
// catalog-quality) — those are now owned by the canonical evidence layer
// (see evidence-actions.test.ts).
// node --conditions=react-server --experimental-strip-types --test lib/actions/action-sources.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { actionsFromAnalytics, actionsFromHealth, actionsFromMedia } from "./action-sources.ts";
import { buildActionCenter } from "./action-model.ts";
import type { AnalyticsSnapshot } from "@/lib/analytics/analytics-read";
import type { HealthCenterModel } from "@/lib/operations/health/health-center";
import type { MediaCenterView } from "@/lib/operations/media/media-center.server";

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

// ── Analytics → inventory rollups only (catalog-quality retired) ───────────────
test("analytics maps inventory rollups; catalog-quality is retired (owned by evidence)", () => {
  const snap = {
    catalogQuality: {
      missingImages: avail(12), // retired → no action
      missingBarcode: avail(4), // retired → no action
      missingPrice: avail(2), // retired → no action
      needsMapping: avail(5), // retired → no action
      needsAi: avail(9), // retired → no action
    },
    inventory: {
      lowStock: avail(7),
      outOfStock: avail(1),
      deadStock: avail(3),
      // an UNKNOWN inventory metric emits nothing
      backorder: unknown(),
    },
  } as unknown as AnalyticsSnapshot;

  const actions = actionsFromAnalytics(snap);
  const byType = new Map(actions.map((a) => [a.type, a]));
  // inventory rollups survive
  assert.ok(byType.has("LOW_STOCK"));
  assert.ok(byType.has("OUT_OF_STOCK"));
  assert.ok(byType.has("ARCHIVE_CANDIDATE")); // dead stock
  assert.equal(byType.get("LOW_STOCK")!.entityId, null); // catalog-wide
  // catalog-quality dimensions are NO LONGER emitted here
  assert.equal(byType.has("IMAGE_REQUIRED"), false, "image quality owned by evidence");
  assert.equal(byType.has("BARCODE_REQUIRED"), false, "barcode owned by evidence");
  assert.equal(byType.has("PRICE_REVIEW"), false, "price owned by evidence");
  assert.equal(byType.has("MAPPING_REVIEW"), false, "mapping owned by evidence");
  assert.equal(byType.has("AI_REVIEW"), false, "ai owned by evidence");
  assert.equal(actions.every((a) => a.source === "analytics"), true);
  assert.deepEqual(actionsFromAnalytics(null), []);
});

// ── OPS Media → IMAGE_REPLACE only (per-product missing retired) ───────────────
test("media duplicates[] → IMAGE_REPLACE; per-product missing is owned by evidence", () => {
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
  assert.equal(req.length, 0, "missing-image is now owned by evidence (CAT_IMAGE_PRIMARY)");
  assert.equal(rep.length, 1);
  assert.equal(rep[0]!.source, "ops_media");
  assert.equal(rep[0]!.evidence[0]!.value, "2"); // affected products
  assert.deepEqual(actionsFromMedia(null), []);
});

// ── integration: surviving adapters aggregate through buildActionCenter ────────
test("surviving adapter outputs aggregate through buildActionCenter into grouped lanes", () => {
  const health = actionsFromHealth({
    findings: [{ domain: "inventory", severity: "action", reason: "نفد", count: 1, workflow: "x", href: "/v2/operations/health" }],
  } as unknown as HealthCenterModel);
  const analytics = actionsFromAnalytics({
    inventory: { lowStock: avail(3) },
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
  assert.ok(view.groups.some((g) => g.type === "LOW_STOCK"));
});
