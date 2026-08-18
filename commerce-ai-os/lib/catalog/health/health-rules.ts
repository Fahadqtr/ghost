// CAT.1A — Catalog Health rule registry (PURE).
//
// Each rule is ISOLATED: it inspects the CatalogHealthInput and returns exactly
// one HealthRuleResult (id, domain, severity, status, scoreImpact, evidence,
// recommendation?). No giant if/else chains — the engine just maps over the
// registry. Rules never mutate, never read a DB/clock/network. Deterministic:
// same input → same result. Certified primitives are reused where they exist
// (BARCODE_RE / MAIN_SKU_RE from the readiness engine, resolveLifecycleState
// from the lifecycle engine) so Health never diverges from those sources.
//
// PURE: `import type` for models; a value import of the two certified regex
// constants + lifecycle resolver (themselves pure, node:test-loadable).

import { BARCODE_RE, MAIN_SKU_RE } from "../../operations/readiness/readiness.ts";
import { resolveLifecycleState } from "../../lifecycle/state.ts";
import type { CatalogHealthInput, HealthDomain, HealthSeverity, HealthStatus } from "./health-model.ts";

const has = (v: string | null | undefined): boolean => typeof v === "string" && v.trim() !== "";
const wordCount = (v: string | null | undefined): number => (has(v) ? v!.trim().split(/\s+/).length : 0);
const keywordCount = (v: string | null | undefined): number =>
  has(v) ? v!.split(",").map((s) => s.trim()).filter(Boolean).length : 0;

// Domain thresholds — documented, aligned with existing house rules.
const DESC_MIN_WORDS = 8;   // below this a description is "weak" (WARNING)
const KEYWORDS_MIN = 3;     // below this a keyword list is "weak" (WARNING)

/** A rule: pure, isolated. */
export interface HealthRule {
  id: string;
  domain: HealthDomain;
  severity: HealthSeverity;
  evaluate(input: CatalogHealthInput): { status: HealthStatus; scoreImpact: number; evidence: string; recommendation?: string };
}

const r = (
  id: string,
  domain: HealthDomain,
  severity: HealthSeverity,
  evaluate: HealthRule["evaluate"],
): HealthRule => ({ id, domain, severity, evaluate });

/** Small helper: a presence rule (FAIL when missing) with a fixed deduction. */
function presence(
  id: string, domain: HealthDomain, severity: HealthSeverity, deduct: number,
  read: (i: CatalogHealthInput) => string | null | undefined,
  missingEvidence: string, recommendation: string,
): HealthRule {
  return r(id, domain, severity, (input) => {
    if (has(read(input))) return { status: "PASS", scoreImpact: 0, evidence: "present" };
    return { status: "FAIL", scoreImpact: deduct, evidence: missingEvidence, recommendation };
  });
}

/** The certified rule registry. Order is stable (deterministic evidence order). */
export const HEALTH_RULES: readonly HealthRule[] = [
  // ── images ──────────────────────────────────────────────────────────────
  r("images.primary", "images", "critical", (i) => {
    if (has(i.imageUrl)) return { status: "PASS", scoreImpact: 0, evidence: "has a primary image" };
    return { status: "FAIL", scoreImpact: 12, evidence: "Missing primary image", recommendation: "Upload a product image." };
  }),

  // ── descriptions ────────────────────────────────────────────────────────
  r("description_ar.quality", "description_ar", "major", (i) => {
    if (!has(i.descriptionAr)) return { status: "FAIL", scoreImpact: 8, evidence: "Missing Arabic description", recommendation: "Add an Arabic description." };
    if (wordCount(i.descriptionAr) < DESC_MIN_WORDS) return { status: "WARNING", scoreImpact: 3, evidence: "Arabic description is very short", recommendation: "Expand the Arabic description." };
    return { status: "PASS", scoreImpact: 0, evidence: "Arabic description present" };
  }),
  r("description_en.quality", "description_en", "major", (i) => {
    if (!has(i.descriptionEn)) return { status: "FAIL", scoreImpact: 8, evidence: "Missing English description", recommendation: "Add an English description." };
    if (wordCount(i.descriptionEn) < DESC_MIN_WORDS) return { status: "WARNING", scoreImpact: 3, evidence: "English description is very short", recommendation: "Expand the English description." };
    return { status: "PASS", scoreImpact: 0, evidence: "English description present" };
  }),

  // ── keywords ────────────────────────────────────────────────────────────
  r("keywords_ar.quality", "keywords_ar", "minor", (i) => {
    if (!has(i.keywordsAr)) return { status: "FAIL", scoreImpact: 4, evidence: "Missing Arabic keywords", recommendation: "Generate Arabic keywords." };
    if (keywordCount(i.keywordsAr) < KEYWORDS_MIN) return { status: "WARNING", scoreImpact: 2, evidence: "Few Arabic keywords", recommendation: "Add more Arabic keywords." };
    return { status: "PASS", scoreImpact: 0, evidence: "Arabic keywords present" };
  }),
  r("keywords_en.quality", "keywords_en", "minor", (i) => {
    if (!has(i.keywordsEn)) return { status: "FAIL", scoreImpact: 4, evidence: "Missing English keywords", recommendation: "Generate English keywords." };
    if (keywordCount(i.keywordsEn) < KEYWORDS_MIN) return { status: "WARNING", scoreImpact: 2, evidence: "Few English keywords", recommendation: "Add more English keywords." };
    return { status: "PASS", scoreImpact: 0, evidence: "English keywords present" };
  }),

  // ── barcode ─────────────────────────────────────────────────────────────
  r("barcode.valid", "barcode", "critical", (i) => {
    if (!has(i.barcode)) return { status: "FAIL", scoreImpact: 10, evidence: "Missing barcode", recommendation: "Assign a valid barcode." };
    if (!BARCODE_RE.test(i.barcode!.trim())) return { status: "WARNING", scoreImpact: 4, evidence: "Barcode format is non-standard", recommendation: "Use a 6–14 digit barcode." };
    return { status: "PASS", scoreImpact: 0, evidence: "Barcode present and well-formed" };
  }),

  // ── SKU integrity ───────────────────────────────────────────────────────
  r("sku.integrity", "sku", "critical", (i) => {
    if (!has(i.sku)) return { status: "FAIL", scoreImpact: 10, evidence: "Missing SKU", recommendation: "Assign an mk<number> SKU." };
    if (!MAIN_SKU_RE.test(i.sku!.trim())) return { status: "WARNING", scoreImpact: 4, evidence: "SKU format is non-standard (expected mk<number>)", recommendation: "Normalize the SKU to mk<number>." };
    return { status: "PASS", scoreImpact: 0, evidence: "SKU present and well-formed" };
  }),

  // ── brand / category / price ───────────────────────────────────────────
  presence("brand.present", "brand", "major", 5, (i) => i.brandId, "Missing brand", "Assign a brand."),
  presence("category.present", "category", "major", 5, (i) => i.category, "Missing category", "Assign a category."),
  r("price.valid", "price", "critical", (i) => {
    if (typeof i.price !== "number" || !Number.isFinite(i.price) || i.price <= 0) {
      return { status: "FAIL", scoreImpact: 10, evidence: "Missing or invalid price", recommendation: "Set a price greater than 0." };
    }
    if (typeof i.discountPrice === "number" && Number.isFinite(i.discountPrice) && i.discountPrice > i.price) {
      return { status: "WARNING", scoreImpact: 3, evidence: "Discount price exceeds the base price", recommendation: "Fix the discount price." };
    }
    return { status: "PASS", scoreImpact: 0, evidence: "Valid price" };
  }),

  // ── lifecycle (reuses the certified resolver; never mutates) ─────────────
  r("lifecycle.state", "lifecycle", "info", (i) => {
    const state = resolveLifecycleState({ lifecycle_state: i.lifecycleState, platform_status: i.platformStatus });
    if (state === "ACTIVE") return { status: "PASS", scoreImpact: 0, evidence: "Lifecycle: ACTIVE" };
    if (state === "STOPPED") return { status: "WARNING", scoreImpact: 2, evidence: "Lifecycle: STOPPED (not selling)", recommendation: "Reactivate if this product should sell." };
    return { status: "WARNING", scoreImpact: 2, evidence: "Lifecycle: DRAFT (not yet active)", recommendation: "Activate when ready." };
  }),

  // ── inventory consistency (UNKNOWN when signals absent) ──────────────────
  r("inventory.consistency", "inventory", "major", (i) => {
    if (i.inventoryTracked == null || i.stockQuantity == null) {
      return { status: "UNKNOWN", scoreImpact: 0, evidence: "Inventory signal not available" };
    }
    if (i.stockQuantity < 0) return { status: "FAIL", scoreImpact: 6, evidence: "Negative on-hand quantity", recommendation: "Reconcile inventory." };
    // Consistency: an In-Stock availability with zero on-hand is inconsistent.
    if (has(i.stockStatus) && i.stockStatus!.trim().toLowerCase() === "in stock" && i.stockQuantity === 0) {
      return { status: "WARNING", scoreImpact: 3, evidence: "Marked In Stock but on-hand is 0", recommendation: "Reconcile availability vs on-hand." };
    }
    return { status: "PASS", scoreImpact: 0, evidence: "Inventory consistent" };
  }),

  // ── availability consistency ─────────────────────────────────────────────
  r("availability.explicit", "availability", "minor", (i) => {
    if (!has(i.stockStatus)) return { status: "UNKNOWN", scoreImpact: 0, evidence: "Availability not set" };
    const v = i.stockStatus!.trim().toLowerCase();
    if (v === "in stock" || v === "out of stock") return { status: "PASS", scoreImpact: 0, evidence: `Availability: ${i.stockStatus!.trim()}` };
    return { status: "WARNING", scoreImpact: 2, evidence: "Availability value is non-standard", recommendation: "Use In Stock / Out of Stock." };
  }),

  // ── ECL completeness ─────────────────────────────────────────────────────
  r("ecl.completeness", "ecl", "major", (i) => {
    if (i.eclActiveCount == null) return { status: "UNKNOWN", scoreImpact: 0, evidence: "ECL mapping not read" };
    if (i.eclActiveCount <= 0) return { status: "FAIL", scoreImpact: 6, evidence: "No ECL mapping", recommendation: "Create an external channel listing mapping." };
    return { status: "PASS", scoreImpact: 0, evidence: `${i.eclActiveCount} active ECL mapping(s)` };
  }),

  // ── channel readiness ────────────────────────────────────────────────────
  r("channel.linked", "channel", "minor", (i) => {
    if (i.channelLinkCount == null) return { status: "UNKNOWN", scoreImpact: 0, evidence: "Channel links not read" };
    if (i.channelLinkCount <= 0) return { status: "WARNING", scoreImpact: 3, evidence: "Not linked to any channel", recommendation: "Link the product to a sales channel." };
    return { status: "PASS", scoreImpact: 0, evidence: `Linked to ${i.channelLinkCount} channel(s)` };
  }),

  // ── AI readiness (detection only — informs AI, never generates) ──────────
  r("ai_readiness.facts", "ai_readiness", "info", (i) => {
    const missing = [!has(i.nameEn) && !has(i.nameAr) ? "name" : null, !has(i.brandId) ? "brand" : null, !has(i.category) ? "category" : null].filter(Boolean);
    if (missing.length === 0) return { status: "PASS", scoreImpact: 0, evidence: "Sufficient facts for safe AI enrichment" };
    return { status: "WARNING", scoreImpact: 2, evidence: `Insufficient grounding facts for AI (${missing.join(", ")})`, recommendation: "Fill core facts before AI enrichment." };
  }),

  // ── export readiness (coarse gate — mirrors the export fail-closed gate) ──
  r("export_readiness.gate", "export_readiness", "major", (i) => {
    const missing = [
      !has(i.sku) ? "SKU" : null,
      !has(i.barcode) ? "barcode" : null,
      !has(i.imageUrl) ? "image" : null,
      typeof i.price !== "number" || !(i.price > 0) ? "price" : null,
    ].filter(Boolean);
    if (missing.length === 0) return { status: "PASS", scoreImpact: 0, evidence: "Meets the baseline export gate" };
    return { status: "WARNING", scoreImpact: 4, evidence: `Export blocked — missing ${missing.join(", ")}`, recommendation: "Complete the missing fields to export." };
  }),
] as const;
