// CAT.1A — Catalog Health engine tests (PURE): rules, scoring, boundaries,
// determinism, regression, distribution.
// node --conditions=react-server --experimental-strip-types --test lib/catalog/health/health-engine.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { computeCatalogHealth, computeHealthDistribution } from "./health-engine.ts";
import { HEALTH_RULES } from "./health-rules.ts";
import { HEALTH_DOMAINS, gradeForScore, type CatalogHealthInput } from "./health-model.ts";

/** A fully-healthy product → every domain PASS → 100 / Excellent. */
function healthy(over: Partial<CatalogHealthInput> = {}): CatalogHealthInput {
  return {
    productId: "p1",
    sku: "mk100", barcode: "6291000000017",
    nameEn: "Rhode Lip Tint", nameAr: "رود ليب تنت",
    descriptionEn: "A glossy hydrating lip tint that gives a natural everyday sheer finish.",
    descriptionAr: "صبغة شفاه لامعة ومرطبة تمنح لمسة طبيعية يومية بلون شفاف جميل ورائع.",
    keywordsEn: "rhode, lip tint, gloss", keywordsAr: "رود, صبغة شفاه, لمعة",
    brandId: "b1", category: "Makeup", price: 100, discountPrice: null,
    imageUrl: "https://cdn.example.com/mk100.jpg", imageCount: 1,
    lifecycleState: "ACTIVE", platformStatus: "Approved", approval: "Approved",
    variantCount: 0, stockStatus: "In Stock",
    inventoryTracked: true, stockQuantity: 5,
    eclActiveCount: 1, channelLinkCount: 1,
    ...over,
  };
}

// ── happy path ────────────────────────────────────────────────────────────────
test("a fully-healthy product scores 100 / Excellent with no evidence", () => {
  const h = computeCatalogHealth(healthy());
  assert.equal(h.score, 100);
  assert.equal(h.grade, "Excellent");
  assert.equal(h.evidence.length, 0);
  assert.equal(h.domains.length, HEALTH_DOMAINS.length);
  assert.ok(h.domains.every((d) => d.status === "PASS"));
});

// ── evidence is always attached to a deduction ───────────────────────────────
test("every deduction carries evidence — never an unexplained score", () => {
  const h = computeCatalogHealth(healthy({ barcode: null, descriptionAr: null, brandId: null }));
  assert.ok(h.score < 100);
  for (const e of h.evidence) {
    assert.ok(e.evidence && e.evidence.trim().length > 0, `${e.id} has evidence`);
    assert.ok(e.scoreImpact > 0, `${e.id} deducts`);
  }
  const msgs = h.evidence.map((e) => e.evidence);
  assert.ok(msgs.some((m) => /Missing barcode/i.test(m)));
  assert.ok(msgs.some((m) => /Missing Arabic description/i.test(m)));
  assert.ok(msgs.some((m) => /Missing brand/i.test(m)));
});

// ── individual domain deductions ─────────────────────────────────────────────
test("missing barcode → barcode FAIL (10) + export gate WARNING (4) → score 86", () => {
  const h = computeCatalogHealth(healthy({ barcode: null }));
  // A missing barcode legitimately harms two listed domains: `barcode` and the
  // composite `export_readiness` gate. Both report independently.
  assert.equal(h.score, 86);
  assert.equal(h.domains.find((x) => x.domain === "barcode")!.status, "FAIL");
  assert.equal(h.domains.find((x) => x.domain === "export_readiness")!.status, "WARNING");
});

test("weak (short) descriptions warn, not fail", () => {
  const h = computeCatalogHealth(healthy({ descriptionEn: "too short", descriptionAr: "قصير جدا" }));
  assert.equal(h.domains.find((x) => x.domain === "description_en")!.status, "WARNING");
  assert.equal(h.domains.find((x) => x.domain === "description_ar")!.status, "WARNING");
  assert.ok(h.score < 100 && h.score > 90);
});

test("discount price above base price warns on the price domain", () => {
  const h = computeCatalogHealth(healthy({ price: 100, discountPrice: 150 }));
  assert.equal(h.domains.find((x) => x.domain === "price")!.status, "WARNING");
});

// ── UNKNOWN never penalizes ──────────────────────────────────────────────────
test("absent inventory / ECL / channel signals are UNKNOWN, not penalized", () => {
  const h = computeCatalogHealth(healthy({ inventoryTracked: null, stockQuantity: null, eclActiveCount: null, channelLinkCount: null, stockStatus: null }));
  for (const dom of ["inventory", "ecl", "channel", "availability"] as const) {
    assert.equal(h.domains.find((x) => x.domain === dom)!.status, "UNKNOWN", `${dom} UNKNOWN`);
  }
  // UNKNOWN domains contribute 0 deduction → still 100.
  assert.equal(h.score, 100);
});

test("inventory inconsistency (In Stock but 0 on-hand) warns", () => {
  const h = computeCatalogHealth(healthy({ stockStatus: "In Stock", inventoryTracked: true, stockQuantity: 0 }));
  assert.equal(h.domains.find((x) => x.domain === "inventory")!.status, "WARNING");
});

test("no ECL mapping → ecl FAIL with 'No ECL mapping' evidence", () => {
  const h = computeCatalogHealth(healthy({ eclActiveCount: 0 }));
  const d = h.domains.find((x) => x.domain === "ecl")!;
  assert.equal(d.status, "FAIL");
  assert.ok(h.evidence.some((e) => /No ECL mapping/i.test(e.evidence)));
});

// ── scoring boundaries + clamp ───────────────────────────────────────────────
test("grade thresholds are exact and deterministic", () => {
  assert.equal(gradeForScore(100), "Excellent");
  assert.equal(gradeForScore(90), "Excellent");
  assert.equal(gradeForScore(89), "Good");
  assert.equal(gradeForScore(75), "Good");
  assert.equal(gradeForScore(74), "Fair");
  assert.equal(gradeForScore(55), "Fair");
  assert.equal(gradeForScore(54), "Poor");
  assert.equal(gradeForScore(30), "Poor");
  assert.equal(gradeForScore(29), "Critical");
  assert.equal(gradeForScore(0), "Critical");
});

test("score is clamped to [0,100] even with everything wrong", () => {
  const h = computeCatalogHealth({
    productId: "empty", sku: null, barcode: null, nameEn: null, nameAr: null,
    descriptionEn: null, descriptionAr: null, keywordsEn: null, keywordsAr: null,
    brandId: null, category: null, price: null, imageUrl: null,
    lifecycleState: null, platformStatus: null, approval: null, variantCount: 0,
    stockStatus: null, eclActiveCount: 0, channelLinkCount: 0,
  });
  assert.ok(h.score >= 0 && h.score <= 100);
  assert.equal(h.grade, "Critical");
});

// ── determinism + regression ─────────────────────────────────────────────────
test("determinism: identical input → identical output (deep equal)", () => {
  const a = computeCatalogHealth(healthy({ barcode: null, brandId: null }));
  const b = computeCatalogHealth(healthy({ barcode: null, brandId: null }));
  assert.deepEqual(a, b);
});

test("regression: every rule id is unique and every domain is represented", () => {
  const ids = HEALTH_RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "rule ids unique");
  const covered = new Set(HEALTH_RULES.map((r) => r.domain));
  for (const d of HEALTH_DOMAINS) assert.ok(covered.has(d), `domain ${d} has a rule`);
});

test("domains appear in the fixed stable order", () => {
  const h = computeCatalogHealth(healthy());
  assert.deepEqual(h.domains.map((d) => d.domain), [...HEALTH_DOMAINS]);
});

// ── distribution ─────────────────────────────────────────────────────────────
test("distribution tallies grades + mean score", () => {
  const set = [
    computeCatalogHealth(healthy()),                          // 100 Excellent
    computeCatalogHealth(healthy({ barcode: null })),         // 86 Good (barcode 10 + export 4)
    computeCatalogHealth(healthy({ sku: null, barcode: null, price: null })), // 66 Fair (10+10+10+ export 4)
  ];
  const dist = computeHealthDistribution(set);
  assert.equal(dist.total, 3);
  assert.equal(dist.byGrade.Excellent, 1);
  assert.equal(dist.byGrade.Good, 1);
  assert.equal(dist.byGrade.Fair, 1);
  assert.equal(dist.averageScore, Math.round((100 + 86 + 66) / 3));
});

test("distribution of an empty set is zeroed", () => {
  const dist = computeHealthDistribution([]);
  assert.equal(dist.total, 0);
  assert.equal(dist.averageScore, 0);
  assert.deepEqual(dist.byGrade, { Excellent: 0, Good: 0, Fair: 0, Poor: 0, Critical: 0 });
});
