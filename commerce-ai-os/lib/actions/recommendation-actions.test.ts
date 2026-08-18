// CAT.1D — Recommendation → Action projection tests (PURE). Proves the Action
// Center consumes the certified Recommendation Engine deterministically, preserves
// priority/confidence/evidence linkage, and dedupes by recommendation identity.
// node --conditions=react-server --experimental-strip-types --test lib/actions/recommendation-actions.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { actionsFromRecommendations, RECOMMENDATION_TO_ACTION } from "./recommendation-actions.ts";
import { buildActionCenter } from "./action-model.ts";
import { RECOMMENDATION_TYPES, type Recommendation, type RecommendationType } from "../catalog/recommendations/recommendation-model.ts";

function rec(over: Partial<Recommendation> = {}): Recommendation {
  const type = over.type ?? "IMAGE_REVIEW";
  const productId = over.productId ?? "p1";
  return {
    id: over.id ?? `${type}:${productId}`,
    type,
    priority: over.priority ?? "MEDIUM",
    confidence: over.confidence ?? "HIGH",
    status: over.status ?? "open",
    productId,
    sourceEvidenceIds: over.sourceEvidenceIds ?? ["CAT_IMAGE_PRIMARY:p1"],
    summary: over.summary ?? "ملخّص",
    details: over.details ?? "تفاصيل",
    ownerApprovalRequired: over.ownerApprovalRequired ?? true,
    workflow: over.workflow ?? "/v2/catalog/p1#health",
    rule: over.rule ?? "rec.image_review",
  };
}

// ── type mapping ──────────────────────────────────────────────────────────────
test("recommendation types map to the semantically-exact action types", () => {
  const cases: [RecommendationType, string][] = [
    ["IMAGE_REVIEW", "IMAGE_REQUIRED"],
    ["DESCRIPTION_REVIEW", "DESCRIPTION_UPDATE"],
    ["KEYWORDS_REVIEW", "KEYWORDS_UPDATE"],
    ["BARCODE_REVIEW", "BARCODE_REQUIRED"],
    ["PRICE_REVIEW", "PRICE_REVIEW"],
    ["CHANNEL_REVIEW", "MAPPING_REVIEW"],
    ["CATEGORY_REVIEW", "UNKNOWN"],
    ["EXPORT_REVIEW", "UNKNOWN"],
    ["READY_FOR_ACTIVATION", "READY_FOR_ACTIVATION"],
    ["REPUBLISH_CANDIDATE", "CHANNEL_REPUBLISH"],
  ];
  for (const [t, a] of cases) {
    const [action] = actionsFromRecommendations([rec({ type: t })]);
    assert.equal(action!.type, a, `${t} → ${a}`);
    assert.equal(action!.source, "recommendation");
  }
  // every recommendation type has a mapping
  for (const t of RECOMMENDATION_TYPES) {
    assert.ok(Object.prototype.hasOwnProperty.call(RECOMMENDATION_TO_ACTION, t), `${t} mapped`);
  }
});

// ── priority → severity, confidence → confidence ──────────────────────────────
test("priority maps to action severity; confidence maps to action confidence", () => {
  assert.equal(actionsFromRecommendations([rec({ priority: "CRITICAL" })])[0]!.severity, "critical");
  assert.equal(actionsFromRecommendations([rec({ priority: "HIGH" })])[0]!.severity, "warning");
  assert.equal(actionsFromRecommendations([rec({ priority: "LOW" })])[0]!.severity, "info");
  assert.equal(actionsFromRecommendations([rec({ confidence: "MEDIUM" })])[0]!.confidence, "medium");
  assert.equal(actionsFromRecommendations([rec({ confidence: "UNKNOWN" })])[0]!.confidence, "low");
});

// ── traceability + labels ─────────────────────────────────────────────────────
test("the action carries rule, evidence-count, workflow and a resolved label", () => {
  const [a] = actionsFromRecommendations(
    [rec({ productId: "p9", sourceEvidenceIds: ["e1", "e2"] })],
    { labels: { p9: "سيروم" } },
  );
  assert.equal(a!.title, "سيروم");
  assert.equal(a!.entityId, "p9");
  assert.equal(a!.workflowHref, "/v2/catalog/p1#health");
  const facts = new Map(a!.evidence.map((e) => [e.label, e.value]));
  assert.equal(facts.get("القاعدة"), "rec.image_review");
  assert.equal(facts.get("أدلة داعمة"), "2");
});

// ── dedupe by recommendation identity ─────────────────────────────────────────
test("one recommendation identity yields at most one action (buildActionCenter dedupe)", () => {
  const inputs = actionsFromRecommendations([rec({ id: "IMAGE_REVIEW:dup" }), rec({ id: "IMAGE_REVIEW:dup" })]);
  assert.equal(inputs[0]!.id, "REC:IMAGE_REVIEW:dup");
  const view = buildActionCenter(inputs);
  assert.equal(view.actions.length, 1);
});

// ── owner lanes ───────────────────────────────────────────────────────────────
test("owner lanes derive deterministically from the projected severity", () => {
  const view = buildActionCenter(actionsFromRecommendations([
    rec({ id: "a:1", productId: "1", priority: "CRITICAL" }),
    rec({ id: "b:2", productId: "2", priority: "MEDIUM" }),
  ]));
  const byId = new Map(view.actions.map((a) => [a.entityId, a.lane]));
  assert.equal(byId.get("1"), "critical");
  assert.equal(byId.get("2"), "approval_required");
});

// ── safety ────────────────────────────────────────────────────────────────────
test("null / empty is safe", () => {
  assert.deepEqual(actionsFromRecommendations(null), []);
  assert.deepEqual(actionsFromRecommendations([]), []);
});
