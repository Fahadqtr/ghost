// CAT.1D — Recommendation → Action projection (PURE).
//
// The Action Center consumes the certified Recommendation Engine (§11): it does
// NOT generate recommendations and no longer projects raw evidence directly.
// This module re-shapes an already-built Recommendation (which itself derives
// only from canonical CAT.1B evidence) into the shared Action model. Deterministic
// maps only — no reinterpretation, no detection, no I/O. Each Action embeds the
// recommendation identity so one recommendation yields at most one action.

import type { ActionInput, ActionType, ActionSeverity, ActionConfidence } from "./action-model.ts";
import {
  PRIORITY_LABEL, TYPE_LABEL,
  type Recommendation, type RecommendationType, type RecommendationPriority, type RecommendationConfidence,
} from "../catalog/recommendations/recommendation-model.ts";

/** Recommendation type → the semantically-exact Action type. Where no exact type
 *  exists (category / export), UNKNOWN is used rather than forcing a wrong type. */
export const RECOMMENDATION_TO_ACTION: Record<RecommendationType, ActionType> = {
  READY_FOR_ACTIVATION: "READY_FOR_ACTIVATION",
  IMAGE_REVIEW: "IMAGE_REQUIRED",
  DESCRIPTION_REVIEW: "DESCRIPTION_UPDATE",
  KEYWORDS_REVIEW: "KEYWORDS_UPDATE",
  BARCODE_REVIEW: "BARCODE_REQUIRED",
  CATEGORY_REVIEW: "UNKNOWN",
  PRICE_REVIEW: "PRICE_REVIEW",
  EXPORT_REVIEW: "UNKNOWN",
  CHANNEL_REVIEW: "MAPPING_REVIEW",
  STOP_CANDIDATE: "STOP_CANDIDATE",
  ARCHIVE_CANDIDATE: "ARCHIVE_CANDIDATE",
  RESTORE_CANDIDATE: "RESTORE_CANDIDATE",
  REPUBLISH_CANDIDATE: "CHANNEL_REPUBLISH",
};

/** Recommendation priority → Action severity (exact priority kept as a fact). */
export const PRIORITY_TO_SEVERITY: Record<RecommendationPriority, ActionSeverity> = {
  CRITICAL: "critical",
  HIGH: "warning",
  MEDIUM: "warning",
  LOW: "info",
};

/** Recommendation confidence → Action confidence (UNKNOWN treated as low). */
export const CONFIDENCE_TO_ACTION: Record<RecommendationConfidence, ActionConfidence> = {
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  UNKNOWN: "low",
};

const CONFIDENCE_LABEL: Record<RecommendationConfidence, string> = {
  HIGH: "عالية", MEDIUM: "متوسطة", LOW: "منخفضة", UNKNOWN: "غير معروفة",
};

export interface RecommendationActionOpts {
  /** productId → display label (name/sku), resolved by the server from the read. */
  labels?: Record<string, string>;
}

/**
 * Project certified recommendations into Action inputs. Deterministic + total.
 * The action id embeds the recommendation identity so buildActionCenter dedupe
 * yields at most one action per recommendation. Supporting evidence ids are
 * carried through for full traceability (§13).
 */
export function actionsFromRecommendations(
  recs: readonly Recommendation[] | null | undefined,
  opts: RecommendationActionOpts = {},
): ActionInput[] {
  if (recs == null) return [];
  const labels = opts.labels ?? {};
  const out: ActionInput[] = [];

  for (const r of recs) {
    if (!r) continue;
    const type: ActionType = RECOMMENDATION_TO_ACTION[r.type] ?? "UNKNOWN";
    const label = labels[r.productId] ?? r.productId;
    out.push({
      id: `REC:${r.id}`, // 1:1 with the recommendation identity → dedupe
      type,
      source: "recommendation",
      severity: PRIORITY_TO_SEVERITY[r.priority],
      confidence: CONFIDENCE_TO_ACTION[r.confidence],
      title: label,
      reason: r.summary,
      evidence: [
        { label: "التوصية", value: TYPE_LABEL[r.type] ?? r.type },
        { label: "الأولوية", value: PRIORITY_LABEL[r.priority] ?? r.priority },
        { label: "الثقة", value: CONFIDENCE_LABEL[r.confidence] ?? r.confidence },
        { label: "القاعدة", value: r.rule },
        { label: "أدلة داعمة", value: String(r.sourceEvidenceIds.length) },
        ...(r.ownerApprovalRequired ? [{ label: "الموافقة", value: "مطلوبة" }] : []),
      ],
      currentState: r.details,
      suggestedState: null,
      entityId: r.productId,
      entityLabel: label,
      workflowHref: r.workflow,
    });
  }

  return out;
}
