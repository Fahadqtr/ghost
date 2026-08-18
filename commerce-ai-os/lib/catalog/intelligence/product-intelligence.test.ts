// CAT.1E — Product Intelligence composer tests (PURE). Proves the panel model is
// composed from the certified engines, is fully explainable (every section
// references its evidence / rule / recommendation), and derives export/AI/lifecycle
// read-only sub-views without inventing anything.
// node --conditions=react-server --experimental-strip-types --test lib/catalog/intelligence/product-intelligence.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildProductIntelligence, deriveExportIntel, deriveAiIntel, deriveLifecycleIntel,
  type ProductIntelligenceInput,
} from "./product-intelligence.ts";
import { buildRecommendations } from "../recommendations/recommendation-engine.ts";
import { EVIDENCE_RULES, type Evidence } from "../evidence/evidence-model.ts";
import type { CatalogHealth } from "../health/health-model.ts";

function ev(ruleId: string, over: Partial<Evidence> = {}): Evidence {
  const meta = EVIDENCE_RULES[ruleId]!;
  const productId = over.productId ?? "p1";
  return {
    id: over.id ?? `${meta.evidenceRuleId}:${productId}`,
    type: over.type ?? meta.type, domain: over.domain ?? meta.domain,
    severity: over.severity ?? "WARNING", confidence: over.confidence ?? meta.confidence,
    source: over.source ?? meta.source, productId, storefront: over.storefront ?? null,
    observedAt: "2026-08-18T00:00:00.000Z", resolvedAt: over.resolvedAt ?? null, active: over.active ?? true,
    ruleId: over.ruleId ?? ruleId, facts: over.facts ?? [], summary: over.summary ?? "ملخّص", details: over.details ?? "تفاصيل",
  };
}

const health = (score: number): CatalogHealth => ({
  productId: "p1", score, grade: score >= 90 ? "Excellent" : "Fair", domains: [], evidence: [],
});

const baseInput = (over: Partial<ProductIntelligenceInput> = {}): ProductIntelligenceInput => ({
  productId: "p1", health: health(80), evidence: [], recommendations: [], lifecycle: null, channels: null, timelineCount: 0,
  ...over,
});

// ── export derivation (§7) ────────────────────────────────────────────────────
test("export intel: blocked from CAT_EXPORT_BLOCKED evidence + EXPORT_REVIEW recommendation", () => {
  const evidence = [ev("export_readiness.gate", { summary: "Export blocked — missing barcode" })];
  const recs = buildRecommendations(evidence, "p1");
  const x = deriveExportIntel(evidence, recs, true);
  assert.equal(x.status, "blocked");
  assert.equal(x.blockingIssues.length, 1);
  assert.equal(x.evidenceIds.length, 1);
  assert.ok(x.recommendationId && x.recommendationId.startsWith("EXPORT_REVIEW:"));
});

test("export intel: ok when health present and no export evidence; unknown without health", () => {
  assert.equal(deriveExportIntel([], [], true).status, "ok");
  assert.equal(deriveExportIntel([], [], false).status, "unknown");
});

// ── AI derivation (§8) ────────────────────────────────────────────────────────
test("ai intel: insufficient_facts from CAT_AI_INSUFFICIENT_FACTS; ready otherwise", () => {
  const gap = deriveAiIntel([ev("ai_readiness.facts", { summary: "Insufficient grounding facts for AI (brand)" })], true);
  assert.equal(gap.status, "insufficient_facts");
  assert.equal(gap.evidenceIds.length, 1);
  assert.equal(deriveAiIntel([], true).status, "ready");
  assert.equal(deriveAiIntel([], false).status, "unknown");
});

// ── lifecycle derivation (§5) ─────────────────────────────────────────────────
test("lifecycle intel: archived + restore availability derived from the OPS.8 view", () => {
  assert.equal(deriveLifecycleIntel(null), null);
  const intel = deriveLifecycleIntel({
    state: "STOPPED", display: "ARCHIVED", ready: false, approved: true, readinessPercent: 100,
    blockingReasons: [], transitions: [{ to: "ACTIVE", allowedNow: true }],
  })!;
  assert.equal(intel.archived, true);
  assert.equal(intel.restoreAvailable, true);
  assert.equal(intel.approved, true);
});

// ── full composition + explainability (§10) ───────────────────────────────────
test("buildProductIntelligence composes sections with evidence/rule/recommendation linkage", () => {
  const evidence = [
    ev("images.primary", { severity: "CRITICAL", summary: "Missing primary image" }),
    ev("ecl.completeness", { summary: "No ECL mapping" }),
  ];
  const recommendations = buildRecommendations(evidence, "p1");
  const model = buildProductIntelligence(baseInput({ evidence, recommendations, timelineCount: 3 }));

  const byKey = new Map(model.sections.map((s) => [s.key, s]));
  assert.equal(byKey.get("health")!.present, true);
  assert.equal(byKey.get("evidence")!.present, true);
  assert.equal(byKey.get("evidence")!.evidenceIds.length, 2);
  assert.equal(byKey.get("recommendations")!.present, true);
  // recommendations section links back to supporting evidence + rule ids
  assert.ok(byKey.get("recommendations")!.recommendationIds.length >= 1);
  assert.ok(byKey.get("recommendations")!.evidenceIds.length >= 1);
  // channels section references the channel/ecl evidence
  assert.ok(byKey.get("channels")!.evidenceIds.some((id) => id.startsWith("CAT_ECL_MISSING")));
  assert.equal(byKey.get("timeline")!.present, true);
  // overall summary is deterministic + health-based
  assert.ok(model.summary.includes("80/100"));
});

test("empty product (no health/evidence) yields a safe, honest model", () => {
  const model = buildProductIntelligence(baseInput({ health: null }));
  assert.equal(model.sections.find((s) => s.key === "health")!.present, false);
  assert.equal(model.export.status, "unknown");
  assert.equal(model.ai.status, "unknown");
  assert.equal(model.summary, "لا تتوفّر بيانات ذكاء لهذا المنتج.");
});

// ── resolved evidence never drives a conclusion ───────────────────────────────
test("resolved / inactive evidence is excluded from the intelligence model", () => {
  const model = buildProductIntelligence(baseInput({
    evidence: [ev("export_readiness.gate", { resolvedAt: "2026-08-18T01:00:00.000Z" })],
  }));
  assert.equal(model.export.status, "ok"); // the resolved blocker does not count
  assert.equal(model.sections.find((s) => s.key === "evidence")!.present, false);
});
