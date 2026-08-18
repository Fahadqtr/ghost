// CAT.1C — Evidence → Action projection tests (PURE). Proves the projection is a
// deterministic, canonical, non-fabricating mapping from CAT.1B Evidence into the
// shared Action model. No DB/network/clock — synthetic Evidence inputs.
// node --conditions=react-server --experimental-strip-types --test lib/actions/evidence-actions.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { actionsFromEvidence, EVIDENCE_RULE_TO_ACTION, evidenceWorkflowHref } from "./evidence-actions.ts";
import { buildActionCenter } from "./action-model.ts";
import { actionsFromLifecycle } from "./action-sources.ts";
import { EVIDENCE_RULES, type Evidence } from "../catalog/evidence/evidence-model.ts";

// Build a realistic Evidence item for a given health rule id (the CAT.1A id). The
// canonical id (`${evidenceRuleId}:${productId}`) mirrors the real engine output.
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
    summary: over.summary ?? "ملخّص الدليل",
    details: over.details ?? "تفاصيل الدليل",
    ...(over.recommendedAction ? { recommendedAction: over.recommendedAction } : {}),
  };
}

// ── type mapping (§4) ─────────────────────────────────────────────────────────
test("evidence rule ids map to the semantically-exact action types", () => {
  const cases: [string, string][] = [
    ["images.primary", "IMAGE_REQUIRED"],
    ["barcode.valid", "BARCODE_REQUIRED"],
    ["description_ar.quality", "DESCRIPTION_UPDATE"],
    ["description_en.quality", "DESCRIPTION_UPDATE"],
    ["keywords_ar.quality", "KEYWORDS_UPDATE"],
    ["keywords_en.quality", "KEYWORDS_UPDATE"],
    ["price.valid", "PRICE_REVIEW"],
    ["ecl.completeness", "MAPPING_REVIEW"],
    ["channel.linked", "MAPPING_REVIEW"], // identity/mapping review
    ["ai_readiness.facts", "AI_REVIEW"],
  ];
  for (const [ruleId, type] of cases) {
    const [a] = actionsFromEvidence([ev(ruleId)]);
    assert.equal(a!.type, type, `${ruleId} → ${type}`);
    assert.equal(a!.source, "evidence");
  }
});

// ── unknown-type fallback (§4) ────────────────────────────────────────────────
test("evidence with no exact action type falls back to UNKNOWN (never forced)", () => {
  for (const ruleId of ["sku.integrity", "brand.present", "category.present", "export_readiness.gate"]) {
    const [a] = actionsFromEvidence([ev(ruleId)]);
    assert.equal(a!.type, "UNKNOWN", `${ruleId} → UNKNOWN`);
  }
});

// ── severity preservation (§14) ───────────────────────────────────────────────
test("severity is preserved: CRITICAL→critical, ERROR/WARNING→warning, INFO→info, and the exact evidence severity is kept as a fact", () => {
  const sev = (s: Evidence["severity"]) => actionsFromEvidence([ev("images.primary", { severity: s })])[0]!;
  assert.equal(sev("CRITICAL").severity, "critical");
  assert.equal(sev("ERROR").severity, "warning");
  assert.equal(sev("WARNING").severity, "warning");
  assert.equal(sev("INFO").severity, "info");
  // exact evidence severity retained (nothing lost in the downcast)
  const a = sev("ERROR");
  assert.ok(a.evidence.some((e) => e.label === "الخطورة" && e.value === "خطأ"));
});

// ── confidence preservation (§14) ─────────────────────────────────────────────
test("confidence is preserved deterministically (UNKNOWN→low) and kept as a fact", () => {
  const conf = (c: Evidence["confidence"]) => actionsFromEvidence([ev("images.primary", { confidence: c })])[0]!;
  assert.equal(conf("HIGH").confidence, "high");
  assert.equal(conf("MEDIUM").confidence, "medium");
  assert.equal(conf("LOW").confidence, "low");
  assert.equal(conf("UNKNOWN").confidence, "low");
  assert.ok(conf("MEDIUM").evidence.some((e) => e.label === "الثقة" && e.value === "متوسطة"));
});

// ── facts + evidence contract preservation (§5/§14) ───────────────────────────
test("projection preserves reason, domain, source, rule id, storefront, facts, recommendation", () => {
  const [a] = actionsFromEvidence([
    ev("ecl.completeness", {
      storefront: "malikas",
      summary: "لا يوجد ربط ECL",
      details: "المنتج غير مربوط بأي قناة خارجية",
      recommendedAction: "أنشئ ربط ECL",
      facts: [{ key: "domain", value: "ecl" }, { key: "status", value: "FAIL" }],
    }),
  ]);
  assert.equal(a!.reason, "لا يوجد ربط ECL");
  assert.equal(a!.currentState, "المنتج غير مربوط بأي قناة خارجية");
  assert.equal(a!.suggestedState, "أنشئ ربط ECL");
  const facts = new Map(a!.evidence.map((e) => [e.label, e.value]));
  assert.equal(facts.get("المجال"), "الربط الخارجي (ECL)");
  assert.equal(facts.get("المصدر"), "الربط الخارجي");
  assert.equal(facts.get("القاعدة"), "CAT_ECL_MISSING");
  assert.equal(facts.get("المتجر"), "malikas");
  assert.ok(a!.evidence.some((e) => e.label === "status" && e.value === "FAIL"));
});

// ── workflow deep-links (§6) ──────────────────────────────────────────────────
test("workflowHref deep-links to the per-product resolver with a valid anchor", () => {
  assert.equal(evidenceWorkflowHref("images", "p1"), "/v2/catalog/p1#health");
  assert.equal(evidenceWorkflowHref("ecl", "p1"), "/v2/catalog/p1#platforms");
  assert.equal(evidenceWorkflowHref("channels", "p1"), "/v2/catalog/p1#platforms");
  assert.equal(evidenceWorkflowHref("pricing", "p1"), "/v2/catalog/p1#details");
  // id is URL-encoded
  assert.equal(evidenceWorkflowHref("images", "a b/c"), "/v2/catalog/a%20b%2Fc#health");
  const [a] = actionsFromEvidence([ev("images.primary", { productId: "xyz" })]);
  assert.equal(a!.workflowHref, "/v2/catalog/xyz#health");
});

// ── labels (§5) ───────────────────────────────────────────────────────────────
test("product label from the server-resolved map is used for title/entityLabel; falls back to id", () => {
  const [named] = actionsFromEvidence([ev("images.primary", { productId: "p9" })], { labels: { p9: "سيروم فيتامين سي" } });
  assert.equal(named!.title, "سيروم فيتامين سي");
  assert.equal(named!.entityLabel, "سيروم فيتامين سي");
  assert.equal(named!.entityId, "p9");
  const [bare] = actionsFromEvidence([ev("images.primary", { productId: "p9" })]);
  assert.equal(bare!.title, "p9");
});

// ── active/resolved semantics (§7) ────────────────────────────────────────────
test("active evidence is included; resolved / inactive evidence is excluded", () => {
  const active = ev("images.primary", { productId: "a1" });
  const resolved = ev("barcode.valid", { productId: "a2", resolvedAt: "2026-08-18T01:00:00.000Z" });
  const inactive = ev("price.valid", { productId: "a3", active: false });
  const actions = actionsFromEvidence([active, resolved, inactive]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.entityId, "a1");
});

// ── lifecycle owned by the lifecycle source, not evidence (§9) ────────────────
test("lifecycle-domain evidence is NOT projected (READY_FOR_ACTIVATION stays with the lifecycle source)", () => {
  const lifeEv = ev("lifecycle.state", { productId: "p1", severity: "INFO" });
  assert.deepEqual(actionsFromEvidence([lifeEv]), []);
  // the certified lifecycle source still emits READY_FOR_ACTIVATION
  const ready = actionsFromLifecycle([
    { productId: "p1", sku: "mk1", name: "منتج", lifecycleState: "DRAFT", ready: true, approved: true, readinessPercent: 100 },
  ]);
  assert.equal(ready[0]!.type, "READY_FOR_ACTIVATION");
});

// ── no fabrication — only registered certified rules ──────────────────────────
test("evidence from an unregistered rule id is never projected", () => {
  const bogus = ev("images.primary", { ruleId: "not.a.real.rule", productId: "p1" });
  assert.deepEqual(actionsFromEvidence([bogus]), []);
  assert.deepEqual(actionsFromEvidence(null), []);
  assert.deepEqual(actionsFromEvidence(undefined), []);
});

// ── dedupe by evidence identity (§3) ──────────────────────────────────────────
test("one active evidence identity yields at most one active action (buildActionCenter dedupe)", () => {
  const e1 = ev("images.primary", { productId: "dup" });
  const e2 = ev("images.primary", { productId: "dup" }); // same identity
  const inputs = actionsFromEvidence([e1, e2]);
  assert.equal(inputs.length, 2); // adapter is a 1:1 translation…
  assert.equal(inputs[0]!.id, inputs[1]!.id); // …with identical ids…
  const view = buildActionCenter(inputs);
  assert.equal(view.actions.length, 1, "…collapsed to exactly one action by identity");
  assert.equal(view.actions[0]!.id, "EV:CAT_IMAGE_PRIMARY:dup");
});

// ── owner-lane grouping (§8) — deterministic, no policy engine ─────────────────
test("owner lanes are derived deterministically from the projected severity", () => {
  const critical = ev("images.primary", { productId: "c1", severity: "CRITICAL" });
  const warning = ev("barcode.valid", { productId: "w1", severity: "WARNING" });
  const view = buildActionCenter(actionsFromEvidence([critical, warning]));
  const byId = new Map(view.actions.map((a) => [a.entityId, a]));
  assert.equal(byId.get("c1")!.lane, "critical");
  assert.equal(byId.get("w1")!.lane, "approval_required");
  // "auto_eligible" is classification only — evidence catalog-quality never lands
  // there here (deterministic; no execution).
  assert.equal(view.summary.autoEligible, 0);
});

// ── mapping table is closed + complete for every registered rule ──────────────
test("every registered evidence rule (except lifecycle) has a deterministic action type", () => {
  for (const [ruleId, meta] of Object.entries(EVIDENCE_RULES)) {
    if (meta.domain === "lifecycle") continue; // owned by the lifecycle source
    assert.ok(
      Object.prototype.hasOwnProperty.call(EVIDENCE_RULE_TO_ACTION, meta.evidenceRuleId),
      `${ruleId} (${meta.evidenceRuleId}) has an action-type mapping`,
    );
  }
});
