// CAT.1D — Recommendation Engine tests (PURE). Proves recommendations derive
// ONLY from canonical evidence, never exist without evidence, combine evidence,
// and carry deterministic priority + confidence + explainability.
// node --conditions=react-server --experimental-strip-types --test lib/catalog/recommendations/recommendation-engine.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRecommendations, buildAllRecommendations, computeRecommendationSummary, RECOMMENDATION_RULES,
} from "./recommendation-engine.ts";
import { RECOMMENDATION_TYPES } from "./recommendation-model.ts";
import { EVIDENCE_RULES, type Evidence } from "../evidence/evidence-model.ts";

function ev(ruleId: string, over: Partial<Evidence> = {}): Evidence {
  const meta = EVIDENCE_RULES[ruleId]!;
  const productId = over.productId ?? "p1";
  return {
    id: over.id ?? `${meta.evidenceRuleId}:${productId}`,
    type: over.type ?? meta.type,
    domain: over.domain ?? meta.domain,
    severity: over.severity ?? "WARNING",
    confidence: over.confidence ?? meta.confidence,
    source: over.source ?? meta.source,
    productId,
    storefront: over.storefront ?? null,
    observedAt: "2026-08-18T00:00:00.000Z",
    resolvedAt: over.resolvedAt ?? null,
    active: over.active ?? true,
    ruleId: over.ruleId ?? ruleId,
    facts: over.facts ?? [{ key: "status", value: "FAIL" }],
    summary: over.summary ?? "ملخّص",
    details: over.details ?? "تفاصيل",
    ...(over.recommendedAction ? { recommendedAction: over.recommendedAction } : {}),
  };
}

// ── evidence → recommendation ─────────────────────────────────────────────────
test("a supporting evidence produces the matching recommendation type", () => {
  assert.equal(buildRecommendations([ev("images.primary")], "p1")[0]!.type, "IMAGE_REVIEW");
  assert.equal(buildRecommendations([ev("barcode.valid")], "p1")[0]!.type, "BARCODE_REVIEW");
  assert.equal(buildRecommendations([ev("price.valid")], "p1")[0]!.type, "PRICE_REVIEW");
  assert.equal(buildRecommendations([ev("keywords_ar.quality")], "p1")[0]!.type, "KEYWORDS_REVIEW");
  assert.equal(buildRecommendations([ev("export_readiness.gate")], "p1")[0]!.type, "EXPORT_REVIEW");
  assert.equal(buildRecommendations([ev("ecl.completeness")], "p1")[0]!.type, "CHANNEL_REVIEW");
  assert.equal(buildRecommendations([ev("channel.linked")], "p1")[0]!.type, "CHANNEL_REVIEW");
  // sku evidence has no recommendation type → no recommendation
  assert.deepEqual(buildRecommendations([ev("sku.integrity")], "p1"), []);
});

// ── composition (§6): multiple evidence → one recommendation ──────────────────
test("multiple supporting evidence combine into ONE recommendation with all source ids", () => {
  const recs = buildRecommendations([ev("description_ar.quality"), ev("description_en.quality")], "p1");
  const desc = recs.filter((r) => r.type === "DESCRIPTION_REVIEW");
  assert.equal(desc.length, 1, "one DESCRIPTION_REVIEW, not two");
  assert.equal(desc[0]!.sourceEvidenceIds.length, 2, "links both supporting evidence ids");
});

test("category review combines category + brand evidence", () => {
  const recs = buildRecommendations([ev("category.present"), ev("brand.present")], "p1");
  const cat = recs.find((r) => r.type === "CATEGORY_REVIEW")!;
  assert.equal(cat.sourceEvidenceIds.length, 2);
});

// ── no recommendation without evidence (§6) ───────────────────────────────────
test("no evidence → no recommendations; non-registered evidence is ignored", () => {
  assert.deepEqual(buildRecommendations([], "p1"), []);
  const bogus = ev("images.primary", { ruleId: "not.a.rule" });
  assert.deepEqual(buildRecommendations([bogus], "p1"), []);
});

// ── priority (§4) deterministic from evidence severity ────────────────────────
test("priority is the highest band among supporting evidence", () => {
  assert.equal(buildRecommendations([ev("images.primary", { severity: "CRITICAL" })], "p1")[0]!.priority, "CRITICAL");
  assert.equal(buildRecommendations([ev("barcode.valid", { severity: "ERROR" })], "p1")[0]!.priority, "HIGH");
  assert.equal(buildRecommendations([ev("price.valid", { severity: "WARNING" })], "p1")[0]!.priority, "MEDIUM");
  assert.equal(buildRecommendations([ev("ai_readiness.facts", { severity: "INFO" })], "p1").length, 0); // ai_readiness has no rec rule
  // combine: highest wins
  const recs = buildRecommendations([
    ev("description_ar.quality", { severity: "WARNING" }),
    ev("description_en.quality", { severity: "CRITICAL" }),
  ], "p1");
  assert.equal(recs[0]!.priority, "CRITICAL");
});

// ── confidence (§5) weakest-link from evidence ────────────────────────────────
test("confidence is the weakest supporting evidence confidence", () => {
  const recs = buildRecommendations([
    ev("description_ar.quality", { confidence: "HIGH" }),
    ev("description_en.quality", { confidence: "LOW" }),
  ], "p1");
  assert.equal(recs[0]!.confidence, "LOW");
  assert.equal(buildRecommendations([ev("images.primary", { confidence: "HIGH" })], "p1")[0]!.confidence, "HIGH");
});

// ── active/resolved ───────────────────────────────────────────────────────────
test("resolved / inactive evidence never produces a recommendation", () => {
  assert.deepEqual(buildRecommendations([ev("images.primary", { resolvedAt: "2026-08-18T01:00:00.000Z" })], "p1"), []);
  assert.deepEqual(buildRecommendations([ev("images.primary", { active: false })], "p1"), []);
});

// ── contract + explainability (§2/§13) ────────────────────────────────────────
test("recommendation carries the full contract incl. rule id, evidence ids, workflow", () => {
  const r = buildRecommendations([ev("images.primary", { productId: "abc" })], "abc")[0]!;
  assert.equal(r.id, "IMAGE_REVIEW:abc");
  assert.equal(r.productId, "abc");
  assert.equal(r.status, "open");
  assert.ok(r.sourceEvidenceIds.length >= 1);
  assert.equal(r.rule, "rec.image_review");
  assert.equal(r.ownerApprovalRequired, true);
  assert.equal(r.workflow, "/v2/catalog/abc#health");
  assert.ok(typeof r.summary === "string" && r.summary.length > 0);
  assert.ok(typeof r.details === "string" && r.details.length > 0);
});

// ── registry (§7): all 13 types registered; candidate types non-firing ────────
test("registry registers all supported types; lifecycle/candidate types are non-firing without evidence", () => {
  const registered = new Set(RECOMMENDATION_RULES.map((r) => r.type));
  for (const t of RECOMMENDATION_TYPES) assert.ok(registered.has(t), `registered ${t}`);
  // rule ids are unique
  const ids = RECOMMENDATION_RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "unique rule ids");
  // candidate/lifecycle types have no evidence backing yet → never fire
  for (const t of ["READY_FOR_ACTIVATION", "STOP_CANDIDATE", "ARCHIVE_CANDIDATE", "RESTORE_CANDIDATE", "REPUBLISH_CANDIDATE"]) {
    const rule = RECOMMENDATION_RULES.find((r) => r.type === t)!;
    assert.equal(rule.evidenceRuleIds.length, 0, `${t} is registered but non-firing`);
  }
});

// ── buildAllRecommendations groups by product ─────────────────────────────────
test("buildAllRecommendations groups a flat evidence list by product", () => {
  const all = buildAllRecommendations([
    ev("images.primary", { productId: "p1" }),
    ev("price.valid", { productId: "p1" }),
    ev("barcode.valid", { productId: "p2" }),
  ]);
  assert.equal(all.filter((r) => r.productId === "p1").length, 2);
  assert.equal(all.filter((r) => r.productId === "p2").length, 1);
});

// ── summary aggregation (§10) ─────────────────────────────────────────────────
test("computeRecommendationSummary aggregates by type + priority + products", () => {
  const recs = buildAllRecommendations([
    ev("images.primary", { productId: "p1", severity: "CRITICAL" }),
    ev("price.valid", { productId: "p2", severity: "CRITICAL" }),
    ev("barcode.valid", { productId: "p2", severity: "WARNING" }),
  ]);
  const s = computeRecommendationSummary(recs);
  assert.equal(s.total, 3);
  assert.equal(s.productsWithRecommendations, 2);
  assert.equal(s.byType.IMAGE_REVIEW, 1);
  assert.equal(s.byPriority.CRITICAL, 2);
  assert.equal(s.byPriority.MEDIUM, 1);
});
