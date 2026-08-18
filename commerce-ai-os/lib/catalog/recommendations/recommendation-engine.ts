// CAT.1D — Certified Recommendation Engine (PURE).
//
// Derives recommendations from CANONICAL CAT.1B Evidence ONLY. Each recommendation
// is implemented as an ISOLATED registry rule (no giant switch, no duplicated
// logic); the engine just maps over the registry. A recommendation is emitted
// ONLY when its supporting evidence is present — nothing is ever fabricated, and
// no recommendation exists without evidence (§6). Priority + confidence are
// derived deterministically from the supporting evidence. Pure: no DB / clock /
// network / mutation.

import { EVIDENCE_RULES, type Evidence } from "../evidence/evidence-model.ts";
import {
  PRIORITY_RANK, CONFIDENCE_RANK, SEVERITY_TO_PRIORITY, recommendationWorkflowHref,
  type Recommendation, type RecommendationType, type RecommendationPriority, type RecommendationConfidence,
} from "./recommendation-model.ts";

/** An isolated recommendation rule: declarative, evidence-driven. */
export interface RecommendationRule {
  /** certified rule id (§13 explainability), e.g. "rec.image_review". */
  id: string;
  type: RecommendationType;
  /**
   * canonical CAT.1B evidence rule ids (CAT_*) that SUPPORT this recommendation.
   * An empty list means the type is registered but no certified evidence exists
   * yet — the rule never fires (honest, documented; see the registry notes).
   */
  evidenceRuleIds: readonly string[];
  ownerApprovalRequired: boolean;
  summary: string;
  /** builds the full "why" from the matched evidence (deterministic). */
  detail: (matched: readonly Evidence[]) => string;
}

const joinSummaries = (matched: readonly Evidence[]): string =>
  matched.map((e) => e.summary).filter(Boolean).join(" · ");

/**
 * The certified recommendation registry. Order is stable (deterministic output).
 * Firing rules (evidence-backed) come first; the lifecycle/candidate types are
 * registered but currently NON-FIRING because the certified per-product signal
 * they need does not exist in the evidence layer yet — they stay honest + empty
 * until a future phase adds that evidence (see each note). READY_FOR_ACTIVATION
 * in particular stays owned by the certified lifecycle readiness+approval source
 * (product-data), which a recommendation may not inspect (§1).
 */
export const RECOMMENDATION_RULES: readonly RecommendationRule[] = [
  {
    id: "rec.image_review", type: "IMAGE_REVIEW",
    evidenceRuleIds: ["CAT_IMAGE_PRIMARY"], ownerApprovalRequired: true,
    summary: "المنتج بحاجة لمراجعة الصور.",
    detail: joinSummaries,
  },
  {
    id: "rec.description_review", type: "DESCRIPTION_REVIEW",
    evidenceRuleIds: ["CAT_DESC_AR", "CAT_DESC_EN"], ownerApprovalRequired: true,
    summary: "الوصف بحاجة لمراجعة أو استكمال.",
    detail: joinSummaries,
  },
  {
    id: "rec.keywords_review", type: "KEYWORDS_REVIEW",
    evidenceRuleIds: ["CAT_KEYWORDS_AR", "CAT_KEYWORDS_EN"], ownerApprovalRequired: true,
    summary: "الكلمات المفتاحية بحاجة لمراجعة.",
    detail: joinSummaries,
  },
  {
    id: "rec.barcode_review", type: "BARCODE_REVIEW",
    evidenceRuleIds: ["CAT_BARCODE_INVALID"], ownerApprovalRequired: true,
    summary: "الباركود بحاجة لمراجعة.",
    detail: joinSummaries,
  },
  {
    id: "rec.category_review", type: "CATEGORY_REVIEW",
    evidenceRuleIds: ["CAT_CATEGORY_MISSING", "CAT_BRAND_MISSING"], ownerApprovalRequired: true,
    summary: "الفئة/البراند بحاجة لمراجعة.",
    detail: joinSummaries,
  },
  {
    id: "rec.price_review", type: "PRICE_REVIEW",
    evidenceRuleIds: ["CAT_PRICE_INVALID"], ownerApprovalRequired: true,
    summary: "السعر بحاجة لمراجعة.",
    detail: joinSummaries,
  },
  {
    id: "rec.export_review", type: "EXPORT_REVIEW",
    evidenceRuleIds: ["CAT_EXPORT_BLOCKED"], ownerApprovalRequired: true,
    summary: "التصدير محجوب حتى تُستكمل المتطلّبات.",
    detail: joinSummaries,
  },
  {
    id: "rec.channel_review", type: "CHANNEL_REVIEW",
    evidenceRuleIds: ["CAT_CHANNEL_UNLINKED", "CAT_ECL_MISSING"], ownerApprovalRequired: true,
    summary: "ربط القنوات بحاجة لمراجعة.",
    detail: joinSummaries,
  },
  // ── registered but non-firing (no certified per-product evidence yet) ────────
  // READY_FOR_ACTIVATION: needs readiness + approval (product-data), owned by the
  // certified lifecycle source; a recommendation may not inspect product data.
  { id: "rec.ready_for_activation", type: "READY_FOR_ACTIVATION", evidenceRuleIds: [], ownerApprovalRequired: true, summary: "جاهز للتفعيل.", detail: joinSummaries },
  // STOP_CANDIDATE: needs a sales/supplier signal not present in the evidence layer.
  { id: "rec.stop_candidate", type: "STOP_CANDIDATE", evidenceRuleIds: [], ownerApprovalRequired: true, summary: "مرشّح للإيقاف.", detail: joinSummaries },
  // ARCHIVE_CANDIDATE: needs no-sales + zero-stock + supplier-inactive (not in evidence batch).
  { id: "rec.archive_candidate", type: "ARCHIVE_CANDIDATE", evidenceRuleIds: [], ownerApprovalRequired: true, summary: "مرشّح للأرشفة.", detail: joinSummaries },
  // RESTORE_CANDIDATE: needs an archived-product signal not present in the evidence layer.
  { id: "rec.restore_candidate", type: "RESTORE_CANDIDATE", evidenceRuleIds: [], ownerApprovalRequired: true, summary: "مرشّح للاسترجاع.", detail: joinSummaries },
  // REPUBLISH_CANDIDATE: needs a delisted-after-publish signal not present in the evidence layer.
  { id: "rec.republish_candidate", type: "REPUBLISH_CANDIDATE", evidenceRuleIds: [], ownerApprovalRequired: true, summary: "مرشّح لإعادة النشر.", detail: joinSummaries },
] as const;

/** canonical evidence rule id for an evidence item (via the CAT.1B registry). */
function canonicalId(e: Evidence): string | undefined {
  return EVIDENCE_RULES[e.ruleId]?.evidenceRuleId;
}

/** Highest-band priority among the supporting evidence (§4). */
function priorityFrom(matched: readonly Evidence[]): RecommendationPriority {
  let best: RecommendationPriority = "LOW";
  for (const e of matched) {
    const p = SEVERITY_TO_PRIORITY[e.severity];
    if (PRIORITY_RANK[p] > PRIORITY_RANK[best]) best = p;
  }
  return best;
}

/** Weakest-link confidence among the supporting evidence (§5). */
function confidenceFrom(matched: readonly Evidence[]): RecommendationConfidence {
  if (matched.length === 0) return "UNKNOWN";
  let worst: RecommendationConfidence = "HIGH";
  for (const e of matched) {
    if (CONFIDENCE_RANK[e.confidence] < CONFIDENCE_RANK[worst]) worst = e.confidence;
  }
  return worst;
}

/**
 * Build the recommendations for ONE product from its canonical evidence. Only
 * active, unresolved evidence is considered; a rule fires only when ≥1 of its
 * supporting evidence ids is present. Deterministic order (registry order).
 */
export function buildRecommendations(evidence: readonly Evidence[], productId: string): Recommendation[] {
  const active = (Array.isArray(evidence) ? evidence : []).filter((e) => e && e.active === true && e.resolvedAt === null);
  const out: Recommendation[] = [];
  for (const rule of RECOMMENDATION_RULES) {
    if (rule.evidenceRuleIds.length === 0) continue; // registered but non-firing
    const matched = active.filter((e) => {
      const c = canonicalId(e);
      return c !== undefined && rule.evidenceRuleIds.includes(c);
    });
    if (matched.length === 0) continue; // no recommendation without evidence (§6)
    out.push({
      id: `${rule.type}:${productId}`,
      type: rule.type,
      priority: priorityFrom(matched),
      confidence: confidenceFrom(matched),
      status: "open",
      productId,
      sourceEvidenceIds: matched.map((e) => e.id),
      summary: rule.summary,
      details: rule.detail(matched) || rule.summary,
      ownerApprovalRequired: rule.ownerApprovalRequired,
      workflow: recommendationWorkflowHref(rule.type, productId),
      rule: rule.id,
    });
  }
  return out;
}

/**
 * Build recommendations across a catalog from a flat evidence list (mixed
 * products). Groups by productId, runs the per-product engine, and returns all
 * recommendations (registry order within each product, products in first-seen
 * order). Pure — no reads.
 */
export function buildAllRecommendations(evidence: readonly Evidence[]): Recommendation[] {
  const byProduct = new Map<string, Evidence[]>();
  for (const e of Array.isArray(evidence) ? evidence : []) {
    if (!e || typeof e.productId !== "string") continue;
    const list = byProduct.get(e.productId);
    if (list) list.push(e);
    else byProduct.set(e.productId, [e]);
  }
  const out: Recommendation[] = [];
  for (const [productId, list] of byProduct) out.push(...buildRecommendations(list, productId));
  return out;
}

// ── operations overview (pure aggregate) ──────────────────────────────────────

export interface RecommendationSummary {
  total: number;
  byType: Record<string, number>;
  byPriority: Record<RecommendationPriority, number>;
  productsWithRecommendations: number;
}

const emptyPriorityCounts = (): Record<RecommendationPriority, number> => ({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 });

/** Aggregate recommendations into an operations overview (§10). Pure. */
export function computeRecommendationSummary(recs: readonly Recommendation[]): RecommendationSummary {
  const byType: Record<string, number> = {};
  const byPriority = emptyPriorityCounts();
  const products = new Set<string>();
  for (const r of recs) {
    byType[r.type] = (byType[r.type] ?? 0) + 1;
    byPriority[r.priority]++;
    products.add(r.productId);
  }
  return { total: recs.length, byType, byPriority, productsWithRecommendations: products.size };
}
