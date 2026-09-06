// TALABAT.NEWPRODUCTS — what must be true before the new-product email may be
// sent, and the category evidence that currently blocks it (PURE).
//
// Email B creates products in a live marketplace menu. Unlike the safe update
// email, a wrong value here does not correct itself on the next send — it
// creates a wrongly-categorised product that someone has to find and fix. So
// this module treats "we do not know" as a blocker rather than a default.

import { TALABAT_OUTPUT_CATEGORIES } from "./native-template.ts";
import { normalizeBaselineCategory, type TalabatBaselineRow } from "./baseline-delta.ts";
import {
  TALABAT_CATEGORIES_APPROVED_TO_CREATE, TALABAT_EXCLUSION_REASON,
  isTalabatExcludedCategory, talabatNewProductCategory,
} from "./category-policy.ts";

// ── the category question ────────────────────────────────────────────────────

/**
 * THE EVIDENCE, AND WHO DECIDED.
 *
 * Three Talabat artifacts exist, with three different shapes:
 *
 *   1. `Talabat_Pharmacy_Inventory_L3_Filled` — Talabat's own inventory
 *      template (STEP 63 evidence, 1146 rows). Column `category::en_QA`.
 *      Values are BARE: "Face Care". All 16 certified categories were observed
 *      verbatim there, which is where the registry's strings come from.
 *
 *   2. `products.xlsx` — Talabat's EXPORT of the live menu (992 rows, the
 *      STEP 79 baseline). Column `category 1`. Values are PREFIXED:
 *      "All Face Care", on 100% of rows across all 13 categories present, with
 *      zero exceptions. After stripping "All " every value matches a certified
 *      output byte-for-byte.
 *
 *   3. Our own certified workbook — column `Category`, bare values.
 *
 * STEP 80 read that as suggestive but not decisive and blocked Email B on it.
 * STEP 81 resolves it by OWNER DECISION, not by new evidence from Talabat: the
 * owner has ruled that new products are submitted as "All " + the certified
 * category, matching the live menu. That is recorded honestly below — the flag
 * means "we know what to send", not "Talabat confirmed it".
 *
 * Nothing here changes the certified registry. The prefix is applied at the
 * Talabat output edge only; see category-policy.ts.
 */
export const CATEGORY_IMPORT_FORMAT_CONFIRMED = true;

/** WHO settled the format above. Never overwrite this with "talabat". */
export const CATEGORY_IMPORT_FORMAT_SOURCE = "owner_decision" as const;

/** The artifacts behind the decision above, kept for the audit trail. */
export const CATEGORY_IMPORT_EVIDENCE = {
  historicalTemplate: {
    file: "Talabat_Pharmacy_Inventory_L3_Filled",
    column: "category::en_QA",
    form: "bare",
    example: "Face Care",
    rows: 1146,
  },
  currentBaselineExport: {
    file: "products.xlsx",
    column: "category 1",
    form: "All-prefixed",
    example: "All Face Care",
    rows: 992,
    prefixedRowShare: 1,
  },
  missingArtifact: "the CURRENT Talabat new-product import template",
  resolution: "settled by owner decision in STEP 81 — emit \"All \" + the certified category, matching the live menu",
} as const;

export interface CategoryMappingRow {
  certifiedCategory: string;
  currentBaselineCategory: string | null;
  /** null while the import format is unconfirmed — never a guess. */
  newProductImportValue: string | null;
  evidence: string;
  confidence: "high" | "medium" | "none";
}

/**
 * The 16 certified categories against the live baseline.
 *
 * `newProductImportValue` is what we would put in `category 1` — the owner's
 * "All " + certified spelling, and null for a category Talabat does not carry,
 * because there is no value that would be correct to send for one.
 */
export function categoryMappingTable(baseline: readonly TalabatBaselineRow[]): CategoryMappingRow[] {
  const present = new Map<string, string>();
  for (const b of baseline) {
    const raw = b.category1;
    if (raw === null) continue;
    const stripped = normalizeBaselineCategory(raw);
    if (stripped !== null && !present.has(stripped)) present.set(stripped, raw);
  }
  return TALABAT_OUTPUT_CATEGORIES.map((certified) => {
    const inMenu = present.get(certified) ?? null;
    const excluded = isTalabatExcludedCategory(certified);
    const approved = TALABAT_CATEGORIES_APPROVED_TO_CREATE.includes(certified);
    return {
      certifiedCategory: certified,
      currentBaselineCategory: inMenu,
      newProductImportValue: talabatNewProductCategory(certified),
      evidence: excluded
        ? `EXCLUDED FROM TALABAT — ${TALABAT_EXCLUSION_REASON[certified] ?? "channel policy"}`
        : inMenu !== null
          ? `live menu holds "${inMenu}" — exact certified bytes behind an "All " prefix`
          : approved
            ? "ABSENT from the live menu — owner-approved, requested as a new Talabat category"
            : "ABSENT from the live Talabat menu — the category itself must be created first",
      confidence: excluded ? "none" : inMenu !== null ? "high" : approved ? "medium" : "none",
    };
  });
}

/**
 * Certified categories the live menu does not contain at all.
 *
 * Includes the ones Talabat excludes, because "absent from the menu" is a fact
 * about the menu. Callers that care about what we are SENDING should use
 * categoriesNeedingCreationBeforeSend, which drops both the excluded ones (we
 * never ship them) and the owner-approved ones (we ship them and ask).
 */
export function categoriesAbsentFromBaseline(baseline: readonly TalabatBaselineRow[]): string[] {
  return categoryMappingTable(baseline)
    .filter((r) => r.currentBaselineCategory === null)
    .map((r) => r.certifiedCategory);
}

/**
 * Absent categories that would genuinely stop a send: not excluded from the
 * channel, and not approved by the owner for Talabat to create. Shipping a
 * product into one of these would ask Talabat to invent a category nobody
 * decided to have.
 */
export function categoriesNeedingCreationBeforeSend(baseline: readonly TalabatBaselineRow[]): string[] {
  return categoriesAbsentFromBaseline(baseline).filter(
    (c) => !isTalabatExcludedCategory(c) && !TALABAT_CATEGORIES_APPROVED_TO_CREATE.includes(c));
}

// ── Email B readiness ────────────────────────────────────────────────────────

export interface NewProductsReadinessInput {
  categoryFormatConfirmed: boolean;
  /**
   * Absent categories the owner has APPROVED for Talabat to create. These do
   * not block: the products ship and the email asks for the category.
   */
  categoriesToRequest: readonly { talabatCategory: string; rowCount: number }[];
  /**
   * Absent categories that are neither excluded nor approved — a real blocker
   * (see categoriesNeedingCreationBeforeSend).
   */
  unapprovedAbsentCategories: readonly string[];
  /** new rows landing in one of those unapproved categories. */
  rowsInUnapprovedCategories: number;
  /** rows withheld by TALABAT_EXCLUDED_CATEGORIES — reported, never a blocker. */
  policyExcludedRows: number;
  workbookRows: number;
  imagePackageBuilt: boolean;
  rowsMissingRequiredImage: number;
  imagesInPackage: number;
  /** rows the certified pipeline blocked (never shipped). */
  blockedRows: number;
  senderAuthenticated: boolean;
}

export interface NewProductsReadiness {
  readyForOwnerReview: boolean;
  sendable: boolean;
  blockers: string[];
  /**
   * Category-creation asks to carry IN the email. Not blockers — the owner
   * decided the products go with the request rather than waiting behind it.
   */
  categoryRequests: string[];
}

/**
 * Decide whether Email B may be reviewed, and whether it may be SENT.
 *
 * The two are deliberately different. The owner should be able to read the
 * draft and inspect the artifacts as soon as they exist — that is how the
 * blockers get resolved. Sending is what must wait for every condition.
 */
export function evaluateNewProductsReadiness(input: NewProductsReadinessInput): NewProductsReadiness {
  const blockers: string[] = [];
  if (!input.categoryFormatConfirmed) {
    blockers.push("CATEGORY_IMPORT_FORMAT_CONFIRMED = NO — we do not know what value Talabat's new-product importer expects for `category 1`");
  }
  if (input.rowsInUnapprovedCategories > 0) {
    blockers.push(`${input.rowsInUnapprovedCategories} new rows are in categories the live Talabat menu does not have and the owner has not approved (${input.unapprovedAbsentCategories.join(", ")})`);
  }
  if (!input.imagePackageBuilt) blockers.push("the new-product image package has not been built");
  if (input.rowsMissingRequiredImage > 0) blockers.push(`${input.rowsMissingRequiredImage} workbook rows have no packaged image`);
  if (input.workbookRows <= 0) blockers.push("the new-product workbook is empty");
  if (input.imagePackageBuilt && input.imagesInPackage <= 0) blockers.push("the image package contains no images");
  if (input.blockedRows > 0) blockers.push(`${input.blockedRows} rows were blocked by the certified pipeline`);
  if (!input.senderAuthenticated) blockers.push("the sender identity is not authenticated with the mail provider");

  // Review and send are deliberately different gates. The owner should be able
  // to read the draft and inspect the artifacts as soon as they exist — that is
  // how the remaining blockers get resolved. Sending waits for all of them.
  return {
    readyForOwnerReview: input.workbookRows > 0 && input.imagePackageBuilt && input.rowsMissingRequiredImage === 0,
    sendable: blockers.length === 0,
    blockers,
    categoryRequests: input.categoriesToRequest.map((c) => c.talabatCategory),
  };
}
