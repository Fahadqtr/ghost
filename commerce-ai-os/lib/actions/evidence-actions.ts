// CAT.1C — Evidence → Action projection (PURE).
//
// The single deterministic layer that turns CANONICAL CAT.1B Evidence into
// Action Center items. Evidence is canonical (CAT.1B): this module invents NO
// severity, NO confidence, NO domain, NO detection heuristic — it only re-shapes
// an already-computed Evidence item into the shared Action model via fixed maps.
// Every projected Action is tagged with its originating evidence identity so one
// active evidence identity yields at most ONE active Action (buildActionCenter
// dedupes by id).
//
// Runtime-pure: relative imports only (no `@/`), no I/O, no clock, no randomness,
// no writes. node:test loads this file directly.

import type { ActionInput, ActionType, ActionSeverity, ActionConfidence } from "./action-model.ts";
import {
  EVIDENCE_RULES,
  type Evidence,
  type EvidenceDomain,
  type EvidenceSeverity,
  type EvidenceConfidence,
  type EvidenceSource,
} from "../catalog/evidence/evidence-model.ts";

// ── deterministic maps (no reinterpretation beyond a fixed projection) ─────────

/**
 * Canonical evidence rule id → the semantically-exact Action type. Where no exact
 * Action type exists (SKU / brand / category / availability / inventory / export)
 * we deliberately fall back to UNKNOWN rather than forcing a wrong type (§4).
 * CAT_LIFECYCLE_STATE is intentionally ABSENT: lifecycle actions come from the
 * certified lifecycle source (READY_FOR_ACTIVATION), never duplicated here (§9).
 */
export const EVIDENCE_RULE_TO_ACTION: Record<string, ActionType> = {
  CAT_IMAGE_PRIMARY: "IMAGE_REQUIRED",
  CAT_DESC_AR: "DESCRIPTION_UPDATE",
  CAT_DESC_EN: "DESCRIPTION_UPDATE",
  CAT_KEYWORDS_AR: "KEYWORDS_UPDATE",
  CAT_KEYWORDS_EN: "KEYWORDS_UPDATE",
  CAT_BARCODE_INVALID: "BARCODE_REQUIRED",
  CAT_SKU_INVALID: "UNKNOWN",
  CAT_BRAND_MISSING: "UNKNOWN",
  CAT_CATEGORY_MISSING: "UNKNOWN",
  CAT_PRICE_INVALID: "PRICE_REVIEW",
  CAT_INVENTORY_INCONSISTENT: "UNKNOWN",
  CAT_AVAILABILITY_UNSET: "UNKNOWN",
  CAT_ECL_MISSING: "MAPPING_REVIEW",
  CAT_CHANNEL_UNLINKED: "MAPPING_REVIEW",
  CAT_AI_INSUFFICIENT_FACTS: "AI_REVIEW",
  CAT_EXPORT_BLOCKED: "UNKNOWN",
};

/**
 * Evidence severity (4-level) → Action severity (3-level). Deterministic and
 * monotonic: the emergency band (CRITICAL) maps to `critical`; ERROR/WARNING both
 * land in `warning`; INFO in `info`. The EXACT evidence severity is preserved as
 * an evidence fact (below) so nothing is lost in the review drawer.
 */
export const EVIDENCE_TO_ACTION_SEVERITY: Record<EvidenceSeverity, ActionSeverity> = {
  CRITICAL: "critical",
  ERROR: "warning",
  WARNING: "warning",
  INFO: "info",
};

/** Evidence confidence → Action confidence. UNKNOWN is treated as low (never invented). */
export const EVIDENCE_TO_ACTION_CONFIDENCE: Record<EvidenceConfidence, ActionConfidence> = {
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  UNKNOWN: "low",
};

// ── AR display labels (evidence enums → Arabic, for the review drawer facts) ───
const DOMAIN_LABEL: Record<EvidenceDomain, string> = {
  catalog: "الكتالوج", images: "الصور", ai: "الذكاء الاصطناعي", lifecycle: "دورة الحياة",
  inventory: "المخزون", availability: "التوفّر", channels: "القنوات", ecl: "الربط الخارجي (ECL)",
  export: "التصدير", pricing: "التسعير", analytics: "التحليلات", media: "الوسائط",
};

const SOURCE_LABEL: Record<EvidenceSource, string> = {
  "catalog-health": "صحة الكتالوج", "image-engine": "محرّك الصور", "availability-engine": "محرّك التوفّر",
  "inventory-engine": "محرّك المخزون", "lifecycle-engine": "محرّك دورة الحياة", "shopify-preview": "معاينة Shopify",
  "talabat-validation": "تحقّق طلبات", ecl: "الربط الخارجي", operations: "العمليات",
};

const SEVERITY_LABEL: Record<EvidenceSeverity, string> = {
  CRITICAL: "حرِج", ERROR: "خطأ", WARNING: "تحذير", INFO: "معلومة",
};

const CONFIDENCE_LABEL: Record<EvidenceConfidence, string> = {
  HIGH: "عالية", MEDIUM: "متوسطة", LOW: "منخفضة", UNKNOWN: "غير معروفة",
};

/**
 * Per-domain anchor on the certified V2 product page — the per-product resolver
 * that HOSTS the CAT.1B unified Evidence section (and links onward to edit). Every
 * anchor is a real section id on /v2/catalog/[id] (§6). The id is URL-encoded.
 */
const DOMAIN_ANCHOR: Record<EvidenceDomain, string> = {
  images: "#health", catalog: "#health", pricing: "#details", ai: "#health",
  lifecycle: "#lifecycle", inventory: "#health", availability: "#health",
  channels: "#platforms", ecl: "#platforms", export: "#health", analytics: "#health", media: "#health",
};

/** Deep-link to the per-product resolver (the product page evidence section). */
export function evidenceWorkflowHref(domain: EvidenceDomain, productId: string): string {
  return `/v2/catalog/${encodeURIComponent(productId)}${DOMAIN_ANCHOR[domain] ?? "#health"}`;
}

export interface EvidenceActionOpts {
  /** productId → display label (name/sku), resolved by the server from the same read. */
  labels?: Record<string, string>;
}

/**
 * Project canonical CAT.1B Evidence into Action inputs. Deterministic + total:
 *   • only ACTIVE, unresolved evidence becomes an action (§7);
 *   • lifecycle-domain evidence is skipped — owned by the lifecycle source (§9);
 *   • only evidence from a REGISTERED certified rule is projected (no fabrication);
 *   • the Action id embeds the evidence identity so one identity ⇒ one action (§3).
 */
export function actionsFromEvidence(
  evidence: readonly Evidence[] | null | undefined,
  opts: EvidenceActionOpts = {},
): ActionInput[] {
  if (evidence == null) return [];
  const labels = opts.labels ?? {};
  const out: ActionInput[] = [];

  for (const e of evidence) {
    if (!e) continue;
    // §7 — active/resolved semantics: resolved evidence is never an active action.
    if (e.active !== true || e.resolvedAt !== null) continue;
    // §9 — lifecycle actions come from the certified lifecycle source, not evidence.
    if (e.domain === "lifecycle") continue;
    // no fabrication — only registered certified rules become actions.
    const canonical = EVIDENCE_RULES[e.ruleId]?.evidenceRuleId;
    if (!canonical) continue;

    const type: ActionType = EVIDENCE_RULE_TO_ACTION[canonical] ?? "UNKNOWN";
    const label = labels[e.productId] ?? e.productId;

    out.push({
      // 1:1 with the evidence identity (`${evidenceRuleId}:${productId}`) → dedupe.
      id: `EV:${e.id}`,
      type,
      source: "evidence",
      severity: EVIDENCE_TO_ACTION_SEVERITY[e.severity],
      confidence: EVIDENCE_TO_ACTION_CONFIDENCE[e.confidence],
      title: label,
      reason: e.summary,
      evidence: [
        { label: "المجال", value: DOMAIN_LABEL[e.domain] ?? e.domain },
        { label: "المصدر", value: SOURCE_LABEL[e.source] ?? e.source },
        { label: "الخطورة", value: SEVERITY_LABEL[e.severity] ?? e.severity },
        { label: "الثقة", value: CONFIDENCE_LABEL[e.confidence] ?? e.confidence },
        { label: "القاعدة", value: canonical },
        ...(e.storefront ? [{ label: "المتجر", value: e.storefront }] : []),
        ...(Array.isArray(e.facts) ? e.facts.map((f) => ({ label: f.key, value: f.value })) : []),
      ],
      currentState: e.details ?? null,
      suggestedState: e.recommendedAction ?? null,
      entityId: e.productId,
      entityLabel: label,
      workflowHref: evidenceWorkflowHref(e.domain, e.productId),
    });
  }

  return out;
}
