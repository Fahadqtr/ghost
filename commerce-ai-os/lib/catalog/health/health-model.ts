// CAT.1A — Catalog Health Engine: model + contracts (PURE).
//
// DETECTION ONLY. This module defines the domains, statuses, grades, the input
// snapshot, and the rule/result contracts for a deterministic per-product Health
// Score. It stores nothing, mutates nothing, and reads no clock/DB/network — it
// is a pure calculation surface any read caller can reuse (Product page,
// Operations, Action Center, AI Center, Export Center).
//
// PURE: `import type` only — node:test loads this file directly.

/** The 18 independently-evaluated health domains. */
export type HealthDomain =
  | "images"
  | "description_ar"
  | "description_en"
  | "keywords_ar"
  | "keywords_en"
  | "barcode"
  | "sku"
  | "brand"
  | "category"
  | "price"
  | "lifecycle"
  | "inventory"
  | "availability"
  | "ecl"
  | "channel"
  | "ai_readiness"
  | "export_readiness";

/** The full ordered domain list (stable — drives deterministic output order). */
export const HEALTH_DOMAINS: readonly HealthDomain[] = [
  "images", "description_ar", "description_en", "keywords_ar", "keywords_en",
  "barcode", "sku", "brand", "category", "price", "lifecycle",
  "inventory", "availability", "ecl", "channel", "ai_readiness", "export_readiness",
] as const;

/** Per-domain / per-rule status. UNKNOWN = no signal available (never penalized). */
export type HealthStatus = "PASS" | "WARNING" | "FAIL" | "UNKNOWN";

/** Rule severity — informational only (drives display + ordering, not the math). */
export type HealthSeverity = "critical" | "major" | "minor" | "info";

/** Overall letter grade derived from the 0–100 score. */
export type HealthGrade = "Excellent" | "Good" | "Fair" | "Poor" | "Critical";

/**
 * The product snapshot a rule may read. Every field is explicit; `null`/absent
 * means "no signal" and yields UNKNOWN for the domains that depend on it — never
 * a fabricated PASS/FAIL. The server reader assembles this from certified
 * readers; nothing here reads a DB.
 */
export interface CatalogHealthInput {
  productId: string;
  sku: string | null;
  barcode: string | null;
  nameEn: string | null;
  nameAr: string | null;
  descriptionEn: string | null;
  descriptionAr: string | null;
  keywordsEn: string | null;
  keywordsAr: string | null;
  brandId: string | null;
  category: string | null;
  price: number | null;
  discountPrice?: number | null;
  imageUrl: string | null;
  /** count of catalog media rows; null = not read (UNKNOWN). */
  imageCount?: number | null;
  /** canonical stored lifecycle_state (OPS.8A); null when unread/absent. */
  lifecycleState: string | null;
  platformStatus: string | null;
  approval: string | null;
  variantCount: number;
  expectsVariants?: boolean;
  /** explicit availability text ("In Stock" / "Out of Stock"); null = UNKNOWN. */
  stockStatus?: string | null;
  /** whether inventory is tracked for this product; null = UNKNOWN. */
  inventoryTracked?: boolean | null;
  /** authoritative on-hand quantity when tracked; null = UNKNOWN. */
  stockQuantity?: number | null;
  /** count of ACTIVE external_channel_listings rows; null = UNKNOWN. */
  eclActiveCount?: number | null;
  /** count of channel links (channel_products) the product has; null = UNKNOWN. */
  channelLinkCount?: number | null;
}

/** One rule's verdict. Deductions are non-negative and only apply on WARNING/FAIL. */
export interface HealthRuleResult {
  id: string;
  domain: HealthDomain;
  severity: HealthSeverity;
  status: HealthStatus;
  /** points removed from 100 (0 for PASS/UNKNOWN). */
  scoreImpact: number;
  /** human-readable reason for the status — NEVER an unexplained score. */
  evidence: string;
  recommendation?: string;
}

/** Rolled-up status + evidence for one domain (worst rule wins). */
export interface DomainHealth {
  domain: HealthDomain;
  status: HealthStatus;
  scoreImpact: number;
  rules: HealthRuleResult[];
}

/** The certified per-product health result. */
export interface CatalogHealth {
  productId: string;
  score: number;        // 0–100
  grade: HealthGrade;
  domains: DomainHealth[];
  /** flat evidence list for every non-PASS/non-UNKNOWN rule, worst-first. */
  evidence: HealthRuleResult[];
}

/** Grade thresholds (inclusive lower bounds). Deterministic + documented. */
export const GRADE_THRESHOLDS: readonly { min: number; grade: HealthGrade }[] = [
  { min: 90, grade: "Excellent" },
  { min: 75, grade: "Good" },
  { min: 55, grade: "Fair" },
  { min: 30, grade: "Poor" },
  { min: 0, grade: "Critical" },
] as const;

export function gradeForScore(score: number): HealthGrade {
  for (const t of GRADE_THRESHOLDS) if (score >= t.min) return t.grade;
  return "Critical";
}
