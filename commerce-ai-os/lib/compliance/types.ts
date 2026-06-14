// Types for the Compliance Checker (Agent #9).
// Mirrors malika-compliance-checker-spec.md §1–§4.

export type Severity = "PASS" | "WARN" | "BLOCK";

export type CheckName =
  | "medical_claims"
  | "image"
  | "format"
  | "price_consistency"
  | "category"
  | "required_fields"
  | "fabricated_data";

export interface CheckResult {
  name: CheckName;
  severity: Severity;
  detail: string;
  evidence: string | null;
}

/** The verdict returned per draft (spec §3 OUTPUT shape). */
export interface Verdict {
  sku: string;
  overall: Severity;
  publish_allowed: boolean;
  needs_human: boolean;
  checks: CheckResult[];
}

/** A product-listing draft handed to the checker (spec §3.1). */
export interface Draft {
  sku: string;
  title_en?: string | null;
  title_ar?: string | null;
  name_en?: string | null;
  name_ar?: string | null;
  main_category?: string | null;
  desc_en?: string | null;
  desc_ar?: string | null;
  keywords_en?: string | null;
  keywords_ar?: string | null;
  size?: string | null;
  price?: number | null;
  discount_price?: number | null;
  platform_prices?: Record<string, number> | null;
  image_url?: string | null;
  image_filename?: string | null;
}

/** Format rules (configurable; default BRAND-PRODUCT-VARIANT via sku_pattern). */
export interface FormatRules {
  sku_pattern: string;
  require_ar: boolean;
  require_en: boolean;
  keywords_min: number;
  keywords_max: number;
}

/** Assembled rules config (from the compliance_rules rows). */
export interface RulesConfig {
  valid_categories: string[];
  forbidden_terms_en: string[];
  forbidden_terms_ar: string[];
  format_rules: FormatRules;
  fabrication_patterns: string[];
  category_fallback: string;
  on_label_claims: string[];
  image_rules: { require_white_bg_check: boolean };
}

/** A compliance_log row (subset the app reads back). */
export interface ComplianceLogRow {
  id: number;
  product_sku: string;
  draft_id: number | null;
  checker_version: string;
  run_at: string;
  overall: Severity;
  publish_allowed: boolean;
  needs_human: boolean;
  failed_checks: CheckResult[];
  reviewed_by: string | null;
  reviewed_at: string | null;
  published_after: boolean;
  notes: string | null;
}

export interface OpResult<T = unknown> {
  ok: boolean;
  error?: string;
  data?: T;
}

/** Storage abstraction (Supabase-backed in prod, fake in tests). */
export interface ComplianceClient {
  /** Assemble the live RulesConfig from compliance_rules. */
  getRules(): Promise<RulesConfig>;
  /** Persist a verdict to compliance_log AND mirror it into loop_log. */
  recordVerdict(
    verdict: Verdict,
    opts?: { draftId?: number | null; checkerVersion?: string; notes?: string }
  ): Promise<OpResult<ComplianceLogRow>>;
  /** Latest verdict row for a SKU (run_at desc), or null if none. */
  getLatestLog(sku: string): Promise<ComplianceLogRow | null>;
}
