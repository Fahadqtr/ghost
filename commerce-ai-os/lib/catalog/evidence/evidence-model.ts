// CAT.1B — Unified Evidence Engine: contract + rule metadata (PURE).
//
// The one canonical Evidence layer. Every finding in the system must originate
// from a certified rule and be expressed as an Evidence item — nothing invents or
// fabricates evidence. This phase is READ-ONLY / detection-only: the engine
// PROJECTS CAT.1A catalog-health rule results into the canonical contract; it
// stores nothing and mutates nothing. Confidence is deterministic (never
// AI-generated). `import type` only — node:test loads this file directly.

import type { HealthDomain, HealthRuleResult } from "../health/health-model.ts";

/** Exactly one primary domain per evidence item. */
export type EvidenceDomain =
  | "catalog" | "images" | "ai" | "lifecycle" | "inventory" | "availability"
  | "channels" | "ecl" | "export" | "pricing" | "analytics" | "media";

/** The ONLY severities. Never invent custom values. */
export type EvidenceSeverity = "INFO" | "WARNING" | "ERROR" | "CRITICAL";

/** Deterministic confidence — never AI-generated. */
export type EvidenceConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

/** Machine code describing the kind of finding. */
export type EvidenceType =
  | "missing_field" | "invalid_format" | "weak_content" | "inconsistency"
  | "not_ready" | "lifecycle_state" | "pricing" | "unmapped";

/** The certified evidence source (origin). Never "manual". */
export type EvidenceSource =
  | "catalog-health" | "image-engine" | "availability-engine" | "inventory-engine"
  | "lifecycle-engine" | "shopify-preview" | "talabat-validation" | "ecl" | "operations";

/** One certified fact backing an evidence item (deterministic, no free prose). */
export interface EvidenceFact {
  key: string;
  value: string;
}

/** The canonical evidence contract. */
export interface Evidence {
  id: string;                 // deterministic: `${ruleId}:${productId}`
  type: EvidenceType;
  domain: EvidenceDomain;
  severity: EvidenceSeverity;
  confidence: EvidenceConfidence;
  source: EvidenceSource;
  productId: string;
  storefront?: string | null;
  observedAt: string;         // ISO — supplied by the caller (engine takes no clock)
  resolvedAt: string | null;  // freshness (nullable); read-only this phase
  active: boolean;
  ruleId: string;             // certified rule id (CAT.1A rule id) the finding came from
  facts: EvidenceFact[];
  summary: string;
  details: string;
  recommendedAction?: string;
}

/** Per-CAT.1A-rule metadata that maps a health rule into the canonical layer. */
export interface EvidenceRuleMeta {
  /** canonical evidence rule id (e.g. CAT_BARCODE_INVALID). */
  evidenceRuleId: string;
  domain: EvidenceDomain;
  source: EvidenceSource;
  type: EvidenceType;
  confidence: EvidenceConfidence;
}

/**
 * Registry mapping each CAT.1A rule id → canonical evidence metadata. This is the
 * single place that assigns evidence rule ids / domains / sources / confidence, so
 * the logic is isolated and never duplicated. Confidence is fixed + deterministic:
 * HIGH for hard/deterministic checks (presence, regex, exact resolution), MEDIUM
 * for heuristic/composite checks (content quality, consistency, readiness gates).
 */
export const EVIDENCE_RULES: Record<string, EvidenceRuleMeta> = {
  "images.primary": { evidenceRuleId: "CAT_IMAGE_PRIMARY", domain: "images", source: "image-engine", type: "missing_field", confidence: "HIGH" },
  "description_ar.quality": { evidenceRuleId: "CAT_DESC_AR", domain: "catalog", source: "catalog-health", type: "weak_content", confidence: "MEDIUM" },
  "description_en.quality": { evidenceRuleId: "CAT_DESC_EN", domain: "catalog", source: "catalog-health", type: "weak_content", confidence: "MEDIUM" },
  "keywords_ar.quality": { evidenceRuleId: "CAT_KEYWORDS_AR", domain: "catalog", source: "catalog-health", type: "weak_content", confidence: "MEDIUM" },
  "keywords_en.quality": { evidenceRuleId: "CAT_KEYWORDS_EN", domain: "catalog", source: "catalog-health", type: "weak_content", confidence: "MEDIUM" },
  "barcode.valid": { evidenceRuleId: "CAT_BARCODE_INVALID", domain: "catalog", source: "catalog-health", type: "invalid_format", confidence: "HIGH" },
  "sku.integrity": { evidenceRuleId: "CAT_SKU_INVALID", domain: "catalog", source: "catalog-health", type: "invalid_format", confidence: "HIGH" },
  "brand.present": { evidenceRuleId: "CAT_BRAND_MISSING", domain: "catalog", source: "catalog-health", type: "missing_field", confidence: "HIGH" },
  "category.present": { evidenceRuleId: "CAT_CATEGORY_MISSING", domain: "catalog", source: "catalog-health", type: "missing_field", confidence: "HIGH" },
  "price.valid": { evidenceRuleId: "CAT_PRICE_INVALID", domain: "pricing", source: "catalog-health", type: "pricing", confidence: "HIGH" },
  "lifecycle.state": { evidenceRuleId: "CAT_LIFECYCLE_STATE", domain: "lifecycle", source: "lifecycle-engine", type: "lifecycle_state", confidence: "HIGH" },
  "inventory.consistency": { evidenceRuleId: "CAT_INVENTORY_INCONSISTENT", domain: "inventory", source: "inventory-engine", type: "inconsistency", confidence: "MEDIUM" },
  "availability.explicit": { evidenceRuleId: "CAT_AVAILABILITY_UNSET", domain: "availability", source: "availability-engine", type: "missing_field", confidence: "HIGH" },
  "ecl.completeness": { evidenceRuleId: "CAT_ECL_MISSING", domain: "ecl", source: "ecl", type: "unmapped", confidence: "HIGH" },
  "channel.linked": { evidenceRuleId: "CAT_CHANNEL_UNLINKED", domain: "channels", source: "catalog-health", type: "not_ready", confidence: "HIGH" },
  "ai_readiness.facts": { evidenceRuleId: "CAT_AI_INSUFFICIENT_FACTS", domain: "ai", source: "catalog-health", type: "not_ready", confidence: "MEDIUM" },
  "export_readiness.gate": { evidenceRuleId: "CAT_EXPORT_BLOCKED", domain: "export", source: "talabat-validation", type: "not_ready", confidence: "MEDIUM" },
};

/** Map a CAT.1A rule result to the canonical evidence severity. */
export function toEvidenceSeverity(r: Pick<HealthRuleResult, "status" | "severity">): EvidenceSeverity {
  if (r.severity === "info") return "INFO";
  if (r.status === "FAIL") return r.severity === "critical" ? "CRITICAL" : r.severity === "major" ? "ERROR" : "WARNING";
  return "WARNING"; // status === "WARNING"
}

/** Severity ordering for deterministic sort (highest first). */
export const SEVERITY_RANK: Record<EvidenceSeverity, number> = { CRITICAL: 3, ERROR: 2, WARNING: 1, INFO: 0 };
export const CONFIDENCE_RANK: Record<EvidenceConfidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };

/** Map a CAT.1A health domain to the canonical evidence domain (fallback). */
export const HEALTH_DOMAIN_TO_EVIDENCE: Record<HealthDomain, EvidenceDomain> = {
  images: "images", description_ar: "catalog", description_en: "catalog",
  keywords_ar: "catalog", keywords_en: "catalog", barcode: "catalog", sku: "catalog",
  brand: "catalog", category: "catalog", price: "pricing", lifecycle: "lifecycle",
  inventory: "inventory", availability: "availability", ecl: "ecl", channel: "channels",
  ai_readiness: "ai", export_readiness: "export",
};
