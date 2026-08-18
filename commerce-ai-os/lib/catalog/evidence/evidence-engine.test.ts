// CAT.1B — Unified Evidence engine tests (PURE): rules, dedupe, ordering,
// severity, confidence, identity, regression, overview.
// node --conditions=react-server --experimental-strip-types --test lib/catalog/evidence/evidence-engine.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { computeCatalogHealth } from "../health/health-engine.ts";
import type { CatalogHealthInput } from "../health/health-model.ts";
import { buildEvidenceFromHealth, dedupeEvidence, computeEvidenceOverview } from "./evidence-engine.ts";
import { EVIDENCE_RULES, type Evidence } from "./evidence-model.ts";

const OBS = "2026-08-18T00:00:00.000Z";

function healthy(over: Partial<CatalogHealthInput> = {}): CatalogHealthInput {
  return {
    productId: "p1", sku: "mk100", barcode: "6291000000017",
    nameEn: "Rhode Lip Tint", nameAr: "رود ليب تنت",
    descriptionEn: "A glossy hydrating lip tint that gives a natural everyday sheer finish.",
    descriptionAr: "صبغة شفاه لامعة ومرطبة تمنح لمسة طبيعية يومية بلون شفاف جميل ورائع.",
    keywordsEn: "rhode, lip tint, gloss", keywordsAr: "رود, صبغة شفاه, لمعة",
    brandId: "b1", category: "Makeup", price: 100, discountPrice: null,
    imageUrl: "https://cdn.example.com/mk100.jpg", imageCount: 1,
    lifecycleState: "ACTIVE", platformStatus: "Approved", approval: "Approved",
    variantCount: 0, stockStatus: "In Stock", inventoryTracked: true, stockQuantity: 5,
    eclActiveCount: 1, channelLinkCount: 1, ...over,
  };
}
const ev = (over: Partial<CatalogHealthInput> = {}) => buildEvidenceFromHealth(computeCatalogHealth(healthy(over)), { observedAt: OBS });

// ── nothing fabricated ────────────────────────────────────────────────────────
test("a healthy product yields ZERO evidence", () => {
  const r = ev();
  assert.equal(r.total, 0);
  assert.equal(r.evidence.length, 0);
  assert.equal(r.summary, "No active evidence");
});

test("every emitted evidence traces to a registered certified rule", () => {
  const r = ev({ barcode: null, brandId: null, eclActiveCount: 0 });
  assert.ok(r.total > 0);
  for (const e of r.evidence) {
    assert.ok(EVIDENCE_RULES[e.ruleId], `ruleId ${e.ruleId} is registered`);
    assert.equal(e.id, `${EVIDENCE_RULES[e.ruleId].evidenceRuleId}:p1`);
    assert.ok(e.summary.trim().length > 0, "has a summary");
    assert.ok(e.facts.length > 0, "carries facts");
  }
});

// ── contract fields ──────────────────────────────────────────────────────────
test("evidence carries the full canonical contract", () => {
  const e = ev({ barcode: null }).evidence[0];
  for (const k of ["id", "type", "domain", "severity", "confidence", "source", "productId", "observedAt", "resolvedAt", "active", "ruleId", "facts", "summary", "details"]) {
    assert.ok(k in e, `has ${k}`);
  }
  assert.equal(e.observedAt, OBS);
  assert.equal(e.resolvedAt, null);
  assert.equal(e.active, true);
  assert.equal(e.productId, "p1");
});

// ── severity mapping ──────────────────────────────────────────────────────────
test("severity maps deterministically (CRITICAL/ERROR/WARNING/INFO)", () => {
  const barcode = ev({ barcode: null }).evidence.find((e) => e.ruleId === "barcode.valid")!;
  assert.equal(barcode.severity, "CRITICAL"); // FAIL + critical
  const brand = ev({ brandId: null }).evidence.find((e) => e.ruleId === "brand.present")!;
  assert.equal(brand.severity, "ERROR"); // FAIL + major
  const kw = ev({ keywordsEn: null }).evidence.find((e) => e.ruleId === "keywords_en.quality")!;
  assert.equal(kw.severity, "WARNING"); // FAIL + minor
  const life = ev({ lifecycleState: "DRAFT", platformStatus: "" }).evidence.find((e) => e.ruleId === "lifecycle.state")!;
  assert.equal(life.severity, "INFO"); // severity info
});

// ── confidence is deterministic ──────────────────────────────────────────────
test("confidence is deterministic per rule (HIGH hard / MEDIUM heuristic)", () => {
  assert.equal(ev({ barcode: null }).evidence.find((e) => e.ruleId === "barcode.valid")!.confidence, "HIGH");
  assert.equal(ev({ descriptionEn: "short" }).evidence.find((e) => e.ruleId === "description_en.quality")!.confidence, "MEDIUM");
});

// ── ordering ─────────────────────────────────────────────────────────────────
test("evidence is ordered by severity desc then confidence desc", () => {
  const r = ev({ barcode: null, brandId: null, keywordsEn: null, lifecycleState: "DRAFT", platformStatus: "" });
  const ranks = r.evidence.map((e) => e.severity);
  const order = { CRITICAL: 3, ERROR: 2, WARNING: 1, INFO: 0 } as const;
  for (let i = 1; i < ranks.length; i++) assert.ok(order[ranks[i - 1]] >= order[ranks[i]], "non-increasing severity");
  assert.equal(ranks[0], "CRITICAL");
});

// ── dedupe ───────────────────────────────────────────────────────────────────
test("duplicate evidence (same id) collapses to exactly one, strongest kept", () => {
  const base = ev({ barcode: null }).evidence[0];
  const weaker: Evidence = { ...base, severity: "WARNING", confidence: "LOW" };
  const stronger: Evidence = { ...base, severity: "CRITICAL", confidence: "HIGH" };
  const out = dedupeEvidence([weaker, stronger, weaker]);
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, "CRITICAL");
  assert.equal(out[0].confidence, "HIGH");
});

// ── identity + determinism ───────────────────────────────────────────────────
test("evidence id is deterministic (ruleId + productId), stable across runs", () => {
  const a = ev({ barcode: null });
  const b = ev({ barcode: null });
  assert.deepEqual(a, b);
  assert.equal(a.evidence[0].id, "CAT_BARCODE_INVALID:p1");
});

test("severity counts match the emitted items", () => {
  const r = ev({ barcode: null, brandId: null, keywordsEn: null });
  const sum = r.severityCounts.CRITICAL + r.severityCounts.ERROR + r.severityCounts.WARNING + r.severityCounts.INFO;
  assert.equal(sum, r.total);
});

// ── overview ─────────────────────────────────────────────────────────────────
test("overview aggregates by domain / severity / source", () => {
  const results = [ev(), ev({ barcode: null }), ev({ eclActiveCount: 0, brandId: null })];
  const o = computeEvidenceOverview(results);
  assert.equal(o.productsWithEvidence, 2);
  assert.ok(o.total >= 3);
  assert.ok(o.byDomain["catalog"] >= 1);
  assert.ok(o.byDomain["ecl"] >= 1);
  assert.ok(o.bySource["ecl"] >= 1);
  assert.ok(o.bySeverity.CRITICAL >= 1); // two missing barcodes
});

test("regression: every CAT.1A-mapped rule id is unique across the registry", () => {
  const ids = Object.values(EVIDENCE_RULES).map((m) => m.evidenceRuleId);
  assert.equal(new Set(ids).size, ids.length, "evidence rule ids unique");
});
