// TALABAT.CATEGORYPOLICY — which certified categories Talabat carries, and how
// a certified category is spelled when we ask Talabat to CREATE a product (PURE).
//
// STEP 81, owner policy. Three separate decisions live here, and they are not
// the same kind of thing:
//
//   1. EXCLUSION. Talabat previously rejected Electronics and Toys as outside
//      our activity with them. Products in those categories are withheld from
//      every Talabat new-product artifact. This is a CHANNEL policy, not a
//      catalog one — the products stay exactly as they are in the canonical
//      catalog and on Snoonu, Rafeeq and Shopify. Nothing in this module can
//      reach those systems; see the guard test.
//
//   2. OUTPUT SPELLING. Talabat's live menu stores every category as
//      "All " + our certified string. The owner has decided that is what we
//      emit for new products. This is an OUTPUT transformation applied at the
//      edge — the certified registry is untouched, and every other consumer of
//      a category still sees the bare certified string.
//
//   3. CREATION REQUEST. Summer And Camping Supplies is approved and wanted,
//      but Talabat's menu does not have it yet. That is a request to make of
//      Talabat, not a reason to withhold the products — so it is surfaced
//      rather than treated as a blocker.

import { newDeltaRows, type TalabatDeltaResult, type TalabatDeltaRow, type TalabatBaselineRow,
  normalizeBaselineCategory } from "./baseline-delta.ts";

// ── 1. exclusion ─────────────────────────────────────────────────────────────

/**
 * Certified categories Talabat does not carry. TALABAT ONLY.
 *
 * Byte-exact certified strings — the Toys entry carries its U+2728 sparkle, so
 * a plain "Toys" is deliberately NOT a member and would not be excluded.
 */
export const TALABAT_EXCLUDED_CATEGORIES: readonly string[] = ["Electronics", "✨Toys"];

/** Why each is excluded, for the owner-facing report. */
export const TALABAT_EXCLUSION_REASON: Record<string, string> = {
  "Electronics": "Talabat rejected this category as outside our activity with them",
  "✨Toys": "Talabat rejected this category as outside our activity with them",
};

export function isTalabatExcludedCategory(category: string | null | undefined): boolean {
  return typeof category === "string" && TALABAT_EXCLUDED_CATEGORIES.includes(category);
}

// ── 1b. authenticity hold (STEP 94B) ─────────────────────────────────────────

/**
 * Individual products withheld from Talabat pending an authenticity review.
 * TALABAT ONLY — exactly like the category exclusion above it, and for the
 * same architectural reason: a channel decision must not become a catalog one.
 *
 * These are watches whose own descriptions call them a "master copy", plus two
 * carrying a trademarked name with no such wording. Submitting them to a
 * marketplace before their source is reviewed is a risk the owner chose not to
 * take; nothing about the products themselves is wrong, and they stay exactly
 * as they are on Snoonu, Rafeeq and Shopify.
 *
 * WHY A LIST IN CODE RATHER THAN A FLAG IN THE DATABASE. The obvious
 * alternative — lifecycle_state = STOPPED — was tried and reverted: STOPPED is
 * read by every channel, so it removed the products from Shopify and Rafeeq and
 * marked them outside the active catalog for Snoonu, to achieve an exclusion
 * wanted on ONE channel. The other candidate, the platform_status approval
 * overlay, has not gated the export since STEP 62 ("approval is NO LONGER an
 * export gate … it never blocks"), so writing to it would have changed nothing
 * at all. A reviewed constant costs a deploy to change and, in exchange, cannot
 * leak to another channel and cannot be altered without a diff someone reads.
 */
export const TALABAT_AUTHENTICITY_HOLD: readonly string[] = [
  // explicit "master copy" wording in the product's own description
  "mk1127", "mk1128", "mk1111", "mk1129", "mk922", "mk923", "mk2321", "mk924",
  // trademarked name, no "master copy" wording — held pending the same review
  "mk2088", "mk2086",
  // held here INSTEAD of lifecycle_state = STOPPED, which reached other channels
  "mk1999", "mk2000", "mk2001",
];

export const TALABAT_AUTHENTICITY_HOLD_REASON = "authenticity_review";

/** Case-insensitive: a SKU's letter case must never decide whether a hold applies. */
export function isTalabatAuthenticityHeld(sku: string | null | undefined): boolean {
  if (typeof sku !== "string") return false;
  const needle = sku.trim().toLowerCase();
  return needle !== "" && TALABAT_AUTHENTICITY_HOLD.some((s) => s.toLowerCase() === needle);
}

/**
 * How a new-product row is classified once channel policy is applied.
 *
 * EXCLUDED_BY_TALABAT_CATEGORY_POLICY is deliberately its own class. These rows
 * are not BLOCKED (nothing is wrong with them) and not MANUAL_REVIEW (there is
 * nothing to decide) — they are intentionally out of scope for this channel.
 */
export type TalabatNewRowClass =
  | "NEW_PRODUCT"
  | "EXCLUDED_BY_TALABAT_CATEGORY_POLICY"
  | "EXCLUDED_BY_TALABAT_AUTHENTICITY_HOLD";

/**
 * The ONE place a new row's channel eligibility is decided.
 *
 * Everything downstream — the workbook, the image selection, the image package,
 * the preview and the send scope — reads allowedNewDeltaRows, so a hold applied
 * here applies everywhere by construction. There is deliberately no second list
 * in another layer to fall out of step with this one.
 *
 * A variant row is held by its PARENT's SKU as well as its own: the hold names
 * a product, and "mk1999-1-black" must not slip through because the list spells
 * the parent.
 */
export function classifyTalabatNewRow(row: TalabatDeltaRow): TalabatNewRowClass {
  if (isTalabatExcludedCategory(row.our.talabatCategory)) return "EXCLUDED_BY_TALABAT_CATEGORY_POLICY";
  if (isTalabatAuthenticityHeld(row.our.sku) || isTalabatAuthenticityHeld(parentSkuOf(row.our.sku))) {
    return "EXCLUDED_BY_TALABAT_AUTHENTICITY_HOLD";
  }
  return "NEW_PRODUCT";
}

/**
 * The parent SKU behind a variant SKU: "mk1999-1-black" → "mk1999".
 *
 * Variant SKUs are the parent followed by "-<index>-<label>", so the parent is
 * the segment before the first hyphen. A SKU with no hyphen is its own parent.
 */
function parentSkuOf(sku: string | null | undefined): string | null {
  if (typeof sku !== "string") return null;
  const i = sku.indexOf("-");
  return i > 0 ? sku.slice(0, i) : null;
}

/** New rows Talabat may have. The ONE input to every new-product artifact. */
export function allowedNewDeltaRows(result: TalabatDeltaResult): TalabatDeltaRow[] {
  return newDeltaRows(result).filter((r) => classifyTalabatNewRow(r) === "NEW_PRODUCT");
}

/** New rows withheld by the authenticity hold — reported, never sent. */
export function authenticityHeldNewDeltaRows(result: TalabatDeltaResult): TalabatDeltaRow[] {
  return newDeltaRows(result).filter(
    (r) => classifyTalabatNewRow(r) === "EXCLUDED_BY_TALABAT_AUTHENTICITY_HOLD");
}

/** New rows withheld from Talabat by ANY channel policy — reported, never sent. */
export function policyExcludedNewDeltaRows(result: TalabatDeltaResult): TalabatDeltaRow[] {
  return newDeltaRows(result).filter((r) => classifyTalabatNewRow(r) !== "NEW_PRODUCT");
}

export interface TalabatCategoryPolicyCounts {
  /** per excluded category: distinct products and sellable rows withheld. */
  byCategory: Record<string, { products: number; rows: number }>;
  totalExcludedProducts: number;
  totalExcludedRows: number;
  allowedProducts: number;
  allowedRows: number;
}

export function talabatCategoryPolicyCounts(result: TalabatDeltaResult): TalabatCategoryPolicyCounts {
  const byCategory: Record<string, { products: number; rows: number }> = {};
  for (const category of TALABAT_EXCLUDED_CATEGORIES) {
    const rows = newDeltaRows(result).filter((r) => r.our.talabatCategory === category);
    byCategory[category] = {
      products: new Set(rows.map((r) => r.our.internalProductId)).size,
      rows: rows.length,
    };
  }
  const excluded = policyExcludedNewDeltaRows(result);
  const allowed = allowedNewDeltaRows(result);
  return {
    byCategory,
    totalExcludedProducts: new Set(excluded.map((r) => r.our.internalProductId)).size,
    totalExcludedRows: excluded.length,
    allowedProducts: new Set(allowed.map((r) => r.our.internalProductId)).size,
    allowedRows: allowed.length,
  };
}

// ── 2. output spelling ───────────────────────────────────────────────────────

/**
 * The prefix Talabat's menu puts in front of every category.
 *
 * Shared with baseline-delta's TALABAT_CATEGORY_MENU_PREFIX, which strips it
 * when READING their export. This one adds it when WRITING a new product, so
 * the two are exact inverses.
 */
export const TALABAT_NEW_PRODUCT_CATEGORY_PREFIX = "All ";

/**
 * "Face Care" → "All Face Care". OUTPUT ONLY.
 *
 * Returns null for an excluded category rather than a string: no caller should
 * ever be able to spell a category we are not sending, and a null forces the
 * mistake to surface instead of silently shipping "All Electronics".
 */
export function talabatNewProductCategory(certified: string | null | undefined): string | null {
  if (typeof certified !== "string" || certified === "") return null;
  if (isTalabatExcludedCategory(certified)) return null;
  return `${TALABAT_NEW_PRODUCT_CATEGORY_PREFIX}${certified}`;
}

// ── 3. creation request ──────────────────────────────────────────────────────

/** Certified categories the owner has approved for Talabat to create. */
export const TALABAT_CATEGORIES_APPROVED_TO_CREATE: readonly string[] = ["Summer And Camping Supplies"];

export interface TalabatCategoryCreationRequest {
  certifiedCategory: string;
  /** exactly what Talabat must create. */
  talabatCategory: string;
  productCount: number;
  rowCount: number;
  approvedByOwner: boolean;
}

/**
 * Categories the allowed new rows land in that Talabat's live menu lacks.
 *
 * Owner-approved ones are a REQUEST carried alongside the attachment. Anything
 * absent that the owner has NOT approved is a genuine blocker — it would create
 * a category on Talabat that nobody decided to have — so both are returned and
 * the readiness check distinguishes them.
 */
export function talabatCategoriesRequiringCreation(
  result: TalabatDeltaResult,
  baseline: readonly TalabatBaselineRow[],
): TalabatCategoryCreationRequest[] {
  const inMenu = new Set<string>();
  for (const b of baseline) {
    const stripped = b.category1 === null ? null : normalizeBaselineCategory(b.category1);
    if (stripped !== null) inMenu.add(stripped);
  }
  const out = new Map<string, TalabatCategoryCreationRequest>();
  for (const r of allowedNewDeltaRows(result)) {
    const certified = r.our.talabatCategory;
    if (certified === null || certified === "" || inMenu.has(certified)) continue;
    const spelled = talabatNewProductCategory(certified);
    if (spelled === null) continue;
    const existing = out.get(certified);
    if (existing) { existing.rowCount += 1; continue; }
    out.set(certified, {
      certifiedCategory: certified,
      talabatCategory: spelled,
      productCount: 0,
      rowCount: 1,
      approvedByOwner: TALABAT_CATEGORIES_APPROVED_TO_CREATE.includes(certified),
    });
  }
  // distinct products per category, counted separately from rows.
  for (const req of out.values()) {
    req.productCount = new Set(
      allowedNewDeltaRows(result)
        .filter((r) => r.our.talabatCategory === req.certifiedCategory)
        .map((r) => r.our.internalProductId),
    ).size;
  }
  return [...out.values()].sort((a, b) => a.certifiedCategory.localeCompare(b.certifiedCategory));
}
