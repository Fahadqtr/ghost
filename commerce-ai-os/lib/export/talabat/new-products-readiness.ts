// TALABAT.NEWPRODUCTS — what must be true before the new-product email may be
// sent, and the category evidence that currently blocks it (PURE).
//
// Email B creates products in a live marketplace menu. Unlike the safe update
// email, a wrong value here does not correct itself on the next send — it
// creates a wrongly-categorised product that someone has to find and fix. So
// this module treats "we do not know" as a blocker rather than a default.

import { TALABAT_OUTPUT_CATEGORIES } from "./native-template.ts";
import { normalizeBaselineCategory, type TalabatBaselineRow } from "./baseline-delta.ts";

// ── the category question ────────────────────────────────────────────────────

/**
 * THE EVIDENCE, AND WHY IT IS NOT ENOUGH.
 *
 * Three different Talabat artifacts exist, with three different shapes:
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
 * A systematic prefix on every row of an EXPORT is at least as consistent with
 * a menu-grouping label as with the stored category name, and (1) is an
 * import-shaped file that used the bare form. But (1) is old, its column is not
 * the column the current sheet uses, and we hold NO current import template and
 * no Talabat documentation.
 *
 * That is suggestive, not decisive, and the cost of being wrong is a
 * mis-created product rather than a rejected file. So the format is UNCONFIRMED
 * and Email B is blocked until Talabat states which form their new-product
 * importer expects. Nothing here changes the certified registry: the evidence
 * does not prove the importer needs a different output representation.
 */
export const CATEGORY_IMPORT_FORMAT_CONFIRMED = false;

/** What we would need to flip the flag above. */
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
  resolution: "ask Talabat which value their new-product importer expects for `category 1`",
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
 * `newProductImportValue` stays null for every row while
 * CATEGORY_IMPORT_FORMAT_CONFIRMED is false — emitting a value here would be
 * the guess this module exists to prevent.
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
    return {
      certifiedCategory: certified,
      currentBaselineCategory: inMenu,
      newProductImportValue: null,
      evidence: inMenu !== null
        ? `live menu holds "${inMenu}" — exact certified bytes behind an "All " prefix`
        : "ABSENT from the live Talabat menu — the category itself must be created first",
      confidence: inMenu !== null ? "high" : "none",
    };
  });
}

/**
 * Certified categories the live menu does not contain at all.
 *
 * This is a SEPARATE blocker from the string format: a product in one of these
 * cannot be created however the value is spelled, because the category does not
 * exist on Talabat's side yet.
 */
export function categoriesAbsentFromBaseline(baseline: readonly TalabatBaselineRow[]): string[] {
  return categoryMappingTable(baseline)
    .filter((r) => r.currentBaselineCategory === null)
    .map((r) => r.certifiedCategory);
}

// ── Email B readiness ────────────────────────────────────────────────────────

export interface NewProductsReadinessInput {
  categoryFormatConfirmed: boolean;
  /** certified categories absent from the live menu (see above). */
  absentCategories: readonly string[];
  /** new rows landing in one of those absent categories. */
  rowsInAbsentCategories: number;
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
    blockers.push("CATEGORY_IMPORT_FORMAT_CONFIRMED = NO — Talabat has not told us whether their new-product importer expects \"Face Care\" or \"All Face Care\"");
  }
  if (input.rowsInAbsentCategories > 0) {
    blockers.push(`${input.rowsInAbsentCategories} new rows are in categories the live Talabat menu does not have (${input.absentCategories.join(", ")}) — those categories must be created first`);
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
  };
}
