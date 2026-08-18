// CAT.1E — Product Intelligence composer (PURE).
//
// Composes the certified read-only engines (CAT.1A health, CAT.1B evidence,
// CAT.1D recommendations, OPS.8 lifecycle, CI platform matrix, timeline) into ONE
// unified diagnostic view-model for the Product Intelligence Panel. It DUPLICATES
// no business logic and performs no reads — every input is already computed by a
// certified loader. Every derived conclusion is EXPLAINABLE: it carries the
// evidence ids / rule ids / recommendation ids it is based on (§10). Pure: no
// DB / clock / network / mutation. `import type` for shapes + a value import of
// the canonical evidence registry (itself pure).

import { EVIDENCE_RULES, type Evidence } from "../evidence/evidence-model.ts";
import type { CatalogHealth } from "../health/health-model.ts";
import type { Recommendation } from "../recommendations/recommendation-model.ts";
import type { PlatformMatrixItem } from "../../operations/platform-matrix.ts";
import type { LifecycleDisplay, AvailableTransition } from "../../lifecycle/transitions.ts";
import type { LifecycleState } from "../../lifecycle/state.ts";

/** The diagnostic sections the panel renders, in display order. */
export type IntelligenceSectionKey =
  | "health" | "evidence" | "recommendations" | "lifecycle" | "channels" | "export" | "ai" | "timeline";

/** Per-section presence + explainability linkage (§10 — no hidden logic). */
export interface IntelligenceSection {
  key: IntelligenceSectionKey;
  title: string;
  present: boolean;
  /** supporting canonical evidence ids (empty when the section is not evidence-backed). */
  evidenceIds: string[];
  /** certified rule ids behind this section's conclusions. */
  ruleIds: string[];
  /** recommendation ids this section references. */
  recommendationIds: string[];
}

export type ExportStatus = "ok" | "blocked" | "unknown";
export interface ExportIntel {
  status: ExportStatus;
  blockingIssues: string[];
  evidenceIds: string[];
  recommendationId: string | null;
}

export type AiStatus = "ready" | "insufficient_facts" | "unknown";
export interface AiIntel {
  status: AiStatus;
  qualityNotes: string[];
  evidenceIds: string[];
}

/** Structural lifecycle input — assignable from OPS.8 ProductLifecycleView. */
export interface LifecycleIntelInput {
  state: LifecycleState;
  display: LifecycleDisplay;
  ready: boolean;
  approved: boolean;
  readinessPercent: number;
  blockingReasons: string[];
  transitions: readonly Pick<AvailableTransition, "to" | "allowedNow">[];
}

export interface LifecycleIntel {
  display: LifecycleDisplay;
  readinessPercent: number;
  approved: boolean;
  ready: boolean;
  archived: boolean;
  /** a RESTORE path (→ ACTIVE) is available now. */
  restoreAvailable: boolean;
  blockingReasons: string[];
}

export interface ProductIntelligenceInput {
  productId: string;
  health: CatalogHealth | null;
  evidence: readonly Evidence[] | null;
  recommendations: readonly Recommendation[] | null;
  lifecycle: LifecycleIntelInput | null;
  channels: PlatformMatrixItem | null;
  timelineCount: number;
}

export interface ProductIntelligence {
  productId: string;
  sections: IntelligenceSection[];
  export: ExportIntel;
  ai: AiIntel;
  lifecycle: LifecycleIntel | null;
  /** one-line overall read (deterministic, evidence-based). */
  summary: string;
}

const SECTION_TITLE: Record<IntelligenceSectionKey, string> = {
  health: "الصحة", evidence: "الأدلة", recommendations: "التوصيات", lifecycle: "دورة الحياة",
  channels: "القنوات", export: "التصدير", ai: "الذكاء الاصطناعي", timeline: "السجل",
};

/** canonical evidence rule id for an evidence item (via the CAT.1B registry). */
function canonical(e: Evidence): string | undefined {
  return EVIDENCE_RULES[e.ruleId]?.evidenceRuleId;
}

const activeOnly = (evidence: readonly Evidence[] | null): Evidence[] =>
  (Array.isArray(evidence) ? evidence : []).filter((e) => e && e.active === true && e.resolvedAt === null);

/** Derive the export sub-view purely from evidence + recommendations (§7 reuse). */
export function deriveExportIntel(
  evidence: readonly Evidence[] | null,
  recommendations: readonly Recommendation[] | null,
  hasHealth: boolean,
): ExportIntel {
  const blockers = activeOnly(evidence).filter((e) => canonical(e) === "CAT_EXPORT_BLOCKED");
  if (blockers.length > 0) {
    const rec = (recommendations ?? []).find((r) => r.type === "EXPORT_REVIEW") ?? null;
    return {
      status: "blocked",
      blockingIssues: blockers.map((e) => e.summary),
      evidenceIds: blockers.map((e) => e.id),
      recommendationId: rec ? rec.id : null,
    };
  }
  return { status: hasHealth ? "ok" : "unknown", blockingIssues: [], evidenceIds: [], recommendationId: null };
}

/** Derive the AI readiness sub-view purely from evidence (§8 reuse; read-only). */
export function deriveAiIntel(evidence: readonly Evidence[] | null, hasHealth: boolean): AiIntel {
  const gaps = activeOnly(evidence).filter((e) => canonical(e) === "CAT_AI_INSUFFICIENT_FACTS");
  if (gaps.length > 0) {
    return { status: "insufficient_facts", qualityNotes: gaps.map((e) => e.summary), evidenceIds: gaps.map((e) => e.id) };
  }
  return { status: hasHealth ? "ready" : "unknown", qualityNotes: [], evidenceIds: [] };
}

/** Derive the lifecycle sub-view from the OPS.8 view (read-only summary). */
export function deriveLifecycleIntel(l: LifecycleIntelInput | null): LifecycleIntel | null {
  if (!l) return null;
  return {
    display: l.display,
    readinessPercent: l.readinessPercent,
    approved: l.approved,
    ready: l.ready,
    archived: l.display === "ARCHIVED",
    restoreAvailable: (l.transitions ?? []).some((t) => t.to === "ACTIVE" && t.allowedNow),
    blockingReasons: Array.isArray(l.blockingReasons) ? l.blockingReasons : [],
  };
}

/**
 * Compose the full Product Intelligence view-model. Deterministic + total. Every
 * section records the evidence/rule/recommendation ids it is based on so the panel
 * can show WHY without any hidden logic (§10).
 */
export function buildProductIntelligence(input: ProductIntelligenceInput): ProductIntelligence {
  const evidence = activeOnly(input.evidence);
  const recommendations = input.recommendations ?? [];
  const hasHealth = input.health !== null;

  const exportIntel = deriveExportIntel(evidence, recommendations, hasHealth);
  const aiIntel = deriveAiIntel(evidence, hasHealth);
  const lifecycleIntel = deriveLifecycleIntel(input.lifecycle);

  const evidenceIds = evidence.map((e) => e.id);
  const evidenceRules = Array.from(new Set(evidence.map((e) => e.ruleId)));
  const recIds = recommendations.map((r) => r.id);
  const recRules = Array.from(new Set(recommendations.map((r) => r.rule)));

  const channelEvidence = evidence.filter((e) => {
    const c = canonical(e);
    return c === "CAT_CHANNEL_UNLINKED" || c === "CAT_ECL_MISSING";
  });

  const sections: IntelligenceSection[] = [
    { key: "health", title: SECTION_TITLE.health, present: hasHealth, evidenceIds: [], ruleIds: [], recommendationIds: [] },
    { key: "evidence", title: SECTION_TITLE.evidence, present: evidence.length > 0, evidenceIds, ruleIds: evidenceRules, recommendationIds: [] },
    { key: "recommendations", title: SECTION_TITLE.recommendations, present: recommendations.length > 0, evidenceIds: Array.from(new Set(recommendations.flatMap((r) => r.sourceEvidenceIds))), ruleIds: recRules, recommendationIds: recIds },
    { key: "lifecycle", title: SECTION_TITLE.lifecycle, present: lifecycleIntel !== null, evidenceIds: [], ruleIds: [], recommendationIds: [] },
    { key: "channels", title: SECTION_TITLE.channels, present: input.channels !== null, evidenceIds: channelEvidence.map((e) => e.id), ruleIds: Array.from(new Set(channelEvidence.map((e) => e.ruleId))), recommendationIds: recommendations.filter((r) => r.type === "CHANNEL_REVIEW").map((r) => r.id) },
    { key: "export", title: SECTION_TITLE.export, present: exportIntel.status !== "unknown", evidenceIds: exportIntel.evidenceIds, ruleIds: exportIntel.evidenceIds.length ? ["export_readiness.gate"] : [], recommendationIds: exportIntel.recommendationId ? [exportIntel.recommendationId] : [] },
    { key: "ai", title: SECTION_TITLE.ai, present: aiIntel.status !== "unknown", evidenceIds: aiIntel.evidenceIds, ruleIds: aiIntel.evidenceIds.length ? ["ai_readiness.facts"] : [], recommendationIds: [] },
    { key: "timeline", title: SECTION_TITLE.timeline, present: input.timelineCount > 0, evidenceIds: [], ruleIds: [], recommendationIds: [] },
  ];

  const grade = input.health ? input.health.grade : "—";
  const score = input.health ? `${input.health.score}/100` : "—";
  const summary = hasHealth
    ? `الصحة ${score} (${grade}) · ${evidence.length} دليل · ${recommendations.length} توصية`
    : "لا تتوفّر بيانات ذكاء لهذا المنتج.";

  return { productId: input.productId, sections, export: exportIntel, ai: aiIntel, lifecycle: lifecycleIntel, summary };
}
