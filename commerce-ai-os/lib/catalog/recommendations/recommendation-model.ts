// CAT.1D — Certified Recommendation Engine: contract + enums + maps (PURE).
//
// Recommendations are a CERTIFIED layer derived ONLY from canonical CAT.1B
// Evidence. A recommendation NEVER inspects product data directly and NEVER
// exists without ≥1 supporting Evidence item. This phase is READ-ONLY / detection
// only — no execution, no mutation. Priority + confidence are DETERMINISTIC,
// derived from the supporting evidence. `import type` only — node:test loads this
// file directly.

import type { EvidenceSeverity, EvidenceConfidence } from "../evidence/evidence-model.ts";

/** The supported recommendation types (§3). Detection only — never executed. */
export type RecommendationType =
  | "READY_FOR_ACTIVATION"
  | "IMAGE_REVIEW"
  | "DESCRIPTION_REVIEW"
  | "KEYWORDS_REVIEW"
  | "BARCODE_REVIEW"
  | "CATEGORY_REVIEW"
  | "PRICE_REVIEW"
  | "EXPORT_REVIEW"
  | "CHANNEL_REVIEW"
  | "STOP_CANDIDATE"
  | "ARCHIVE_CANDIDATE"
  | "RESTORE_CANDIDATE"
  | "REPUBLISH_CANDIDATE";

/** The full ordered type list (stable — drives deterministic output order). */
export const RECOMMENDATION_TYPES: readonly RecommendationType[] = [
  "READY_FOR_ACTIVATION", "IMAGE_REVIEW", "DESCRIPTION_REVIEW", "KEYWORDS_REVIEW",
  "BARCODE_REVIEW", "CATEGORY_REVIEW", "PRICE_REVIEW", "EXPORT_REVIEW", "CHANNEL_REVIEW",
  "STOP_CANDIDATE", "ARCHIVE_CANDIDATE", "RESTORE_CANDIDATE", "REPUBLISH_CANDIDATE",
] as const;

/** Deterministic priority (§4). */
export type RecommendationPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** Confidence (§5) — derived from evidence only; identical scale to evidence. */
export type RecommendationConfidence = EvidenceConfidence; // "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN"

/** Recommendation lifecycle status. This read-only phase only ever emits "open". */
export type RecommendationStatus = "open" | "resolved" | "dismissed";

/** The canonical recommendation contract (§2 + §13 explainability: `rule`). */
export interface Recommendation {
  id: string;                       // deterministic: `${type}:${productId}`
  type: RecommendationType;
  priority: RecommendationPriority;
  confidence: RecommendationConfidence;
  status: RecommendationStatus;
  productId: string;
  /** the CAT.1B evidence ids this recommendation is derived from (never empty). */
  sourceEvidenceIds: string[];
  summary: string;                  // why (short)
  details: string;                  // why (full)
  ownerApprovalRequired: boolean;
  workflow: string;                 // deep-link to the existing resolver
  /** §13 explainability — the certified registry rule id that produced this. */
  rule: string;
}

/** Priority rank for deterministic ordering / roll-up (highest first). */
export const PRIORITY_RANK: Record<RecommendationPriority, number> = { CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };
export const CONFIDENCE_RANK: Record<RecommendationConfidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };

/**
 * Deterministic priority from an evidence severity (§4). The recommendation
 * priority is the HIGHEST band among its supporting evidence.
 */
export const SEVERITY_TO_PRIORITY: Record<EvidenceSeverity, RecommendationPriority> = {
  CRITICAL: "CRITICAL",
  ERROR: "HIGH",
  WARNING: "MEDIUM",
  INFO: "LOW",
};

/** Per-type product-page anchor — the resolver that hosts the evidence (§9). */
export const TYPE_ANCHOR: Record<RecommendationType, string> = {
  READY_FOR_ACTIVATION: "#lifecycle",
  IMAGE_REVIEW: "#health",
  DESCRIPTION_REVIEW: "#health",
  KEYWORDS_REVIEW: "#health",
  BARCODE_REVIEW: "#details",
  CATEGORY_REVIEW: "#details",
  PRICE_REVIEW: "#details",
  EXPORT_REVIEW: "#health",
  CHANNEL_REVIEW: "#platforms",
  STOP_CANDIDATE: "#lifecycle",
  ARCHIVE_CANDIDATE: "#lifecycle",
  RESTORE_CANDIDATE: "#lifecycle",
  REPUBLISH_CANDIDATE: "#platforms",
};

/** Deep-link to the per-product resolver (product page section). Id URL-encoded. */
export function recommendationWorkflowHref(type: RecommendationType, productId: string): string {
  return `/v2/catalog/${encodeURIComponent(productId)}${TYPE_ANCHOR[type] ?? "#health"}`;
}

/** AR labels for the supported types (read-only UI). */
export const TYPE_LABEL: Record<RecommendationType, string> = {
  READY_FOR_ACTIVATION: "جاهز للتفعيل",
  IMAGE_REVIEW: "مراجعة الصور",
  DESCRIPTION_REVIEW: "مراجعة الوصف",
  KEYWORDS_REVIEW: "مراجعة الكلمات المفتاحية",
  BARCODE_REVIEW: "مراجعة الباركود",
  CATEGORY_REVIEW: "مراجعة الفئة والبراند",
  PRICE_REVIEW: "مراجعة السعر",
  EXPORT_REVIEW: "مراجعة التصدير",
  CHANNEL_REVIEW: "مراجعة القنوات والربط",
  STOP_CANDIDATE: "مرشّح للإيقاف",
  ARCHIVE_CANDIDATE: "مرشّح للأرشفة",
  RESTORE_CANDIDATE: "مرشّح للاسترجاع",
  REPUBLISH_CANDIDATE: "مرشّح لإعادة النشر",
};

export const PRIORITY_LABEL: Record<RecommendationPriority, string> = {
  CRITICAL: "حرِج", HIGH: "عالية", MEDIUM: "متوسطة", LOW: "منخفضة",
};
