// CAT.1B — Unified Evidence engine (PURE).
//
// Projects CAT.1A catalog-health results into the canonical Evidence contract,
// deduplicates, orders deterministically, and summarizes. It is the single place
// findings become Evidence — nothing here fabricates: an item is emitted ONLY for
// a triggered (FAIL/WARNING) certified health rule, tagged with that rule's id.
// Pure: no DB/clock/network/mutation. `observedAt` is supplied by the caller.

import type { CatalogHealth } from "../health/health-model.ts";
import {
  EVIDENCE_RULES, HEALTH_DOMAIN_TO_EVIDENCE, SEVERITY_RANK, CONFIDENCE_RANK, toEvidenceSeverity,
  type Evidence, type EvidenceSeverity, type EvidenceDomain, type EvidenceSource,
} from "./evidence-model.ts";

export interface EvidenceContext {
  observedAt: string;              // ISO timestamp from the caller
  storefront?: string | null;
}

export interface EvidenceResult {
  productId: string;
  evidence: Evidence[];            // ordered, deduped
  severityCounts: Record<EvidenceSeverity, number>;
  total: number;
  summary: string;
}

const emptySeverityCounts = (): Record<EvidenceSeverity, number> => ({ CRITICAL: 0, ERROR: 0, WARNING: 0, INFO: 0 });

/** Deterministic ordering: severity desc, confidence desc, then ruleId. */
function order(a: Evidence, b: Evidence): number {
  return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    || CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence]
    || a.ruleId.localeCompare(b.ruleId);
}

/**
 * Deduplicate by evidence identity (`id` = ruleId:productId), keeping the
 * strongest (highest severity, then confidence). Multiple engines detecting the
 * same issue collapse to exactly ONE item.
 */
export function dedupeEvidence(items: Evidence[]): Evidence[] {
  const best = new Map<string, Evidence>();
  for (const e of items) {
    const cur = best.get(e.id);
    if (!cur || SEVERITY_RANK[e.severity] > SEVERITY_RANK[cur.severity] ||
        (SEVERITY_RANK[e.severity] === SEVERITY_RANK[cur.severity] && CONFIDENCE_RANK[e.confidence] > CONFIDENCE_RANK[cur.confidence])) {
      best.set(e.id, e);
    }
  }
  return [...best.values()];
}

/**
 * Build canonical Evidence from one product's CAT.1A health. Only FAIL/WARNING
 * rules that have registry metadata become evidence (PASS/UNKNOWN never do).
 */
export function buildEvidenceFromHealth(health: CatalogHealth, ctx: EvidenceContext): EvidenceResult {
  const raw: Evidence[] = [];
  for (const r of health.evidence) { // health.evidence is already FAIL/WARNING only
    const meta = EVIDENCE_RULES[r.id];
    if (!meta) continue; // no fabricated evidence — only registered rules
    const domain: EvidenceDomain = meta.domain ?? HEALTH_DOMAIN_TO_EVIDENCE[r.domain];
    const source: EvidenceSource = meta.source;
    raw.push({
      id: `${meta.evidenceRuleId}:${health.productId}`,
      type: meta.type,
      domain,
      severity: toEvidenceSeverity(r),
      confidence: meta.confidence,
      source,
      productId: health.productId,
      storefront: ctx.storefront ?? null,
      observedAt: ctx.observedAt,
      resolvedAt: null,
      active: true,
      ruleId: r.id,
      facts: [
        { key: "domain", value: r.domain },
        { key: "status", value: r.status },
        { key: "scoreImpact", value: String(r.scoreImpact) },
      ],
      summary: r.evidence,
      details: r.evidence,
      ...(r.recommendation ? { recommendedAction: r.recommendation } : {}),
    });
  }

  const evidence = dedupeEvidence(raw).sort(order);
  const severityCounts = emptySeverityCounts();
  for (const e of evidence) severityCounts[e.severity]++;

  return {
    productId: health.productId,
    evidence,
    severityCounts,
    total: evidence.length,
    summary: evidence.length === 0
      ? "No active evidence"
      : `${evidence.length} item(s): ${severityCounts.CRITICAL} critical, ${severityCounts.ERROR} error, ${severityCounts.WARNING} warning, ${severityCounts.INFO} info`,
  };
}

// ── Operations overview (pure aggregate) ──────────────────────────────────────

export interface EvidenceOverview {
  total: number;
  byDomain: Record<string, number>;
  bySeverity: Record<EvidenceSeverity, number>;
  bySource: Record<string, number>;
  productsWithEvidence: number;
}

/** Aggregate a set of per-product evidence results into an operations overview. */
export function computeEvidenceOverview(results: readonly EvidenceResult[]): EvidenceOverview {
  const byDomain: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const bySeverity = emptySeverityCounts();
  let total = 0;
  let productsWithEvidence = 0;
  for (const res of results) {
    if (res.total > 0) productsWithEvidence++;
    for (const e of res.evidence) {
      total++;
      byDomain[e.domain] = (byDomain[e.domain] ?? 0) + 1;
      bySource[e.source] = (bySource[e.source] ?? 0) + 1;
      bySeverity[e.severity]++;
    }
  }
  return { total, byDomain, bySeverity, bySource, productsWithEvidence };
}
