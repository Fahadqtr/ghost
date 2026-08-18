// CAT.1A — Catalog Health engine + scoring + distribution (PURE).
//
// Runs the isolated rule registry over one product snapshot, rolls results up by
// domain, and produces a deterministic 0–100 score + grade + evidence. It is the
// single certified computation the read API, Product page, Operations, Action
// Center, AI Center and Export Center all consume. Pure: no DB/clock/network/
// mutation. Same input → same output (determinism is test-pinned).
//
// PURE: `import type` for models + a value import of the pure rule registry.

import { HEALTH_RULES } from "./health-rules.ts";
import {
  HEALTH_DOMAINS, gradeForScore,
  type CatalogHealthInput, type CatalogHealth, type DomainHealth,
  type HealthRuleResult, type HealthStatus, type HealthGrade,
} from "./health-model.ts";

/** Worst-wins ordering for rolling rule statuses up to a domain status. */
const STATUS_RANK: Record<HealthStatus, number> = { FAIL: 3, WARNING: 2, UNKNOWN: 1, PASS: 0 };
const SEVERITY_RANK = { critical: 0, major: 1, minor: 2, info: 3 } as const;

function rollupStatus(results: HealthRuleResult[]): HealthStatus {
  if (results.length === 0) return "UNKNOWN";
  // If every rule is UNKNOWN → UNKNOWN; otherwise the worst of PASS/WARN/FAIL wins.
  const known = results.filter((x) => x.status !== "UNKNOWN");
  if (known.length === 0) return "UNKNOWN";
  return known.reduce<HealthStatus>((worst, x) => (STATUS_RANK[x.status] > STATUS_RANK[worst] ? x.status : worst), "PASS");
}

/**
 * Compute the certified health of one product. Score = 100 minus the sum of every
 * rule's deduction, clamped to [0,100]; grade from the fixed thresholds. Evidence
 * is every non-PASS / non-UNKNOWN rule, ordered worst-status then severity — so a
 * score is never unexplained.
 */
export function computeCatalogHealth(input: CatalogHealthInput): CatalogHealth {
  const results: HealthRuleResult[] = HEALTH_RULES.map((rule) => {
    const out = rule.evaluate(input);
    return {
      id: rule.id,
      domain: rule.domain,
      severity: rule.severity,
      status: out.status,
      // Deductions only ever apply on WARNING/FAIL (defensive clamp to ≥0).
      scoreImpact: out.status === "WARNING" || out.status === "FAIL" ? Math.max(0, out.scoreImpact) : 0,
      evidence: out.evidence,
      ...(out.recommendation ? { recommendation: out.recommendation } : {}),
    };
  });

  const rawScore = 100 - results.reduce((sum, x) => sum + x.scoreImpact, 0);
  const score = Math.max(0, Math.min(100, rawScore));
  const grade: HealthGrade = gradeForScore(score);

  // Domain rollup in the fixed HEALTH_DOMAINS order (deterministic).
  const domains: DomainHealth[] = HEALTH_DOMAINS.map((domain) => {
    const rules = results.filter((x) => x.domain === domain);
    return { domain, status: rollupStatus(rules), scoreImpact: rules.reduce((s, x) => s + x.scoreImpact, 0), rules };
  });

  const evidence = results
    .filter((x) => x.status === "FAIL" || x.status === "WARNING")
    .sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status] || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.scoreImpact - a.scoreImpact);

  return { productId: input.productId, score, grade, domains, evidence };
}

// ── Operations distribution (pure) ────────────────────────────────────────────

export interface HealthDistribution {
  total: number;
  byGrade: Record<HealthGrade, number>;
  averageScore: number; // rounded
}

/** Tally a set of computed healths into a grade distribution + mean score. */
export function computeHealthDistribution(healths: readonly CatalogHealth[]): HealthDistribution {
  const byGrade: Record<HealthGrade, number> = { Excellent: 0, Good: 0, Fair: 0, Poor: 0, Critical: 0 };
  let sum = 0;
  for (const h of healths) { byGrade[h.grade]++; sum += h.score; }
  const total = healths.length;
  return { total, byGrade, averageScore: total ? Math.round(sum / total) : 0 };
}
