// Shared variant + product validation layer (UX.4E-3).
//
// ONE home for the field-shape rules that Create (create-validation),
// Edit (edit-validation), and Import (excel-import/core) each used to inline
// separately, so the three paths cannot drift. This module is the single
// source of truth for: name-required, SKU format (main + variant), EAN-13,
// the loose import barcode shape, price/stock number checks, within-form and
// against-catalog duplicate detection, empty-row detection, and the (unwired)
// variant-count-limit predicate.
//
// Purity contract (enforced by the Node test runner AND relied on by the
// client wizard + the server actions that all import this file): completely
// pure and deterministic — no React, no server code, no `@/` imports, no
// Supabase, no browser APIs, no clock, no randomness. The only value imports
// are the existing pure identity helpers, re-exported here so callers have a
// single import surface for the shared rules.

import type { ProductInput, VariantInput } from "./product-save.ts";
import { isValidEan13 } from "./barcode-ean13.ts";
import { isValidMkSku, isValidVariantMkSku } from "./sku-generate.ts";

// Re-export the atomic format rules so every caller imports the shared rules
// from ONE place, even though the primitives keep living in their own pure
// modules (barcode-ean13 owns EAN-13; sku-generate owns the mk-SKU grammar).
export { isValidEan13 } from "./barcode-ean13.ts";
export { isValidMkSku, isValidVariantMkSku } from "./sku-generate.ts";

// ─────────────────────────── text / number rules ───────────────────────────

/** Whitespace-only (or nullish) is blank. */
export function isBlankText(v: string): boolean {
  return (v ?? "").trim() === "";
}

/** Blank is allowed (means NULL); anything else must parse to a finite number. */
export function isBadNumber(v: string): boolean {
  const t = (v ?? "").trim();
  if (t === "") return false;
  return !Number.isFinite(Number(t));
}

/** Blank is allowed; anything else must be a finite number >= 0. */
export function isNegativeNumber(v: string): boolean {
  const t = (v ?? "").trim();
  if (t === "") return false;
  const n = Number(t);
  return Number.isFinite(n) && n < 0;
}

/** Required-name rule: a product needs a name in at least one language. */
export function isNameMissing(nameAr: string, nameEn: string): boolean {
  return isBlankText(nameAr) && isBlankText(nameEn);
}

// ─────────────────────── import-shape rules (loose) ─────────────────────────
//
// Kept BYTE-IDENTICAL to the regexes in excel-import/core.ts (a drift guard in
// variant-validate.test.ts proves they never diverge). Import normalizes cell
// text to lowercase before testing the SKU shapes and strips whitespace before
// the barcode shape, exactly as core.ts does; the strict Create/Edit rules
// (isValidMkSku / isValidVariantMkSku / isValidEan13) are the ones re-exported
// above and are deliberately distinct.

/** Main SKU shape as Import matches it: mk<digits> on normalized text. */
export const MAIN_SKU_RE = /^mk[0-9]+$/;
/** Variant SKU shape as Import matches it: mk<digits>-<n>, n >= 1. */
export const VARIANT_SKU_RE = /^mk[0-9]+-[1-9][0-9]*$/;
/** Import's deliberately loose barcode shape: 6–14 digits, no check digit. */
export const LOOSE_BARCODE_RE = /^\d{6,14}$/;

// ───────────────────────── duplicate detection ─────────────────────────────

/**
 * Index of the first value that repeats an earlier one, or -1 when every value
 * is distinct. Empty/blank entries are compared verbatim (callers filter first
 * when blanks should be ignored). This is the within-form duplicate rule.
 */
export function firstDuplicateIndex(values: readonly string[]): number {
  const seen = new Set<string>();
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (seen.has(v)) return i;
    seen.add(v);
  }
  return -1;
}

/** Against-catalog rule: is `value` already present in the catalog id set? */
export function isTakenInCatalog(value: string, catalog: ReadonlySet<string>): boolean {
  return catalog.has(value);
}

/** Every value that collides with the catalog id set, in input order. */
export function findCatalogDuplicates(
  values: readonly string[],
  catalog: ReadonlySet<string>,
): string[] {
  return values.filter((v) => catalog.has(v));
}

// ───────────────────────────── empty rows ──────────────────────────────────

/**
 * Empty-row rule: a variant row carries real data when it has a name (either
 * language) or a SKU. Blank/whitespace-only rows are empty. Mirrors
 * isMeaningfulVariant's "retained" rule (kept in sync by a guard test).
 */
export function isEmptyVariantRow(v: Pick<VariantInput, "variant_name" | "variant_name_en" | "sku">): boolean {
  return (
    isBlankText(v.variant_name) &&
    isBlankText(v.variant_name_en) &&
    isBlankText(v.sku)
  );
}

// ────────────────────────── variant count limit ────────────────────────────

/**
 * Variant-count-limit rule. There is NO limit enforced anywhere today, so this
 * takes the ceiling as a parameter (no magic number is baked in and no caller
 * is wired to it): it is the pure predicate the shared layer exposes so the
 * rule has one home if a limit is ever introduced.
 */
export function exceedsVariantLimit(count: number, max: number): boolean {
  return count > max;
}

// ─────────────────── the shared product validation engine ───────────────────

/** The number fields validated on the product and on each variant. */
export const PRODUCT_NUMBER_FIELDS = ["price", "discount_price", "cost", "stock_quantity"] as const satisfies readonly (keyof ProductInput)[];
export const VARIANT_NUMBER_FIELDS = ["price", "stock_quantity"] as const satisfies readonly (keyof VariantInput)[];

/** The rule a failed validation tripped — callers map this to their message. */
export type ValidationRule =
  | "name_required"
  | "category_required"
  | "invalid_sku"
  | "invalid_barcode"
  | "invalid_variant_sku"
  | "duplicate_in_form"
  | "duplicate_variant_row"
  | "invalid_number"
  | "negative_number";

export type ProductValidation =
  | { ok: true }
  | {
      ok: false;
      rule: ValidationRule;
      /** DOM-id SUFFIX of the offending field; the caller prefixes create-/edit-. */
      field: string;
    };

/**
 * Which checks the engine runs. Create and Edit differ only in these flags, so
 * the ordering + logic below is the SINGLE implementation both share:
 * - Create: requireCategory, no row-id check.
 * - Edit: no category, plus the DB row-id duplicate check; every SKU/barcode/
 *   EAN/duplicate check is now ON too (UX.4E-3 validation parity).
 */
export interface ProductValidateOptions {
  requireCategory: boolean;
  checkMainSku: boolean;
  checkMainBarcode: boolean;
  checkVariantSku: boolean;
  checkVariantBarcode: boolean;
  checkFormDuplicates: boolean;
  checkVariantRowIdDup: boolean;
}

/** Every check on — the Create profile (also Edit's, minus the two flags). */
export const CREATE_PROFILE: ProductValidateOptions = {
  requireCategory: true,
  checkMainSku: true,
  checkMainBarcode: true,
  checkVariantSku: true,
  checkVariantBarcode: true,
  checkFormDuplicates: true,
  checkVariantRowIdDup: false,
};

/** Edit profile: parity with Create on SKU/barcode/EAN/dups, minus category,
 *  plus the existing DB row-id duplicate guard. */
export const EDIT_PROFILE: ProductValidateOptions = {
  requireCategory: false,
  checkMainSku: true,
  checkMainBarcode: true,
  checkVariantSku: true,
  checkVariantBarcode: true,
  checkFormDuplicates: true,
  checkVariantRowIdDup: true,
};

/**
 * Validate a product payload (product scalars + variant rows) against the
 * shared rules. Returns the first failing rule + field suffix, or ok. Pure;
 * order is fixed so Create and Edit produce identical results for identical
 * inputs (differing only by the field-id prefix and the message table).
 */
export function validateProductFields(
  input: ProductInput,
  opts: ProductValidateOptions,
): ProductValidation {
  if (isNameMissing(input.name_ar, input.name_en)) {
    return { ok: false, rule: "name_required", field: "name_ar" };
  }
  if (opts.requireCategory && isBlankText(input.main_category)) {
    return { ok: false, rule: "category_required", field: "main_category" };
  }

  const mainSku = (input.sku ?? "").trim();
  if (opts.checkMainSku && !isValidMkSku(mainSku)) {
    return { ok: false, rule: "invalid_sku", field: "sku" };
  }
  const mainBarcode = (input.barcode ?? "").trim();
  if (opts.checkMainBarcode && !isValidEan13(mainBarcode)) {
    return { ok: false, rule: "invalid_barcode", field: "barcode" };
  }

  for (const f of PRODUCT_NUMBER_FIELDS) {
    if (isBadNumber(input[f])) return { ok: false, rule: "invalid_number", field: f };
    if (isNegativeNumber(input[f])) return { ok: false, rule: "negative_number", field: f };
  }

  // Within-form duplicate sets are seeded with the main identifiers so a
  // variant colliding with the product itself is caught (Create's behavior).
  const seenSkus = new Set<string>([mainSku.toLowerCase()]);
  const seenBarcodes = new Set<string>([mainBarcode]);
  const seenIds = new Set<string>();

  const variants = Array.isArray(input.variants) ? input.variants : [];
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];

    if (opts.checkVariantRowIdDup) {
      const id = typeof v.id === "string" ? v.id.trim() : "";
      if (id.length > 0) {
        if (seenIds.has(id)) {
          return { ok: false, rule: "duplicate_variant_row", field: "variants" };
        }
        seenIds.add(id);
      }
    }

    const vSku = (v.sku ?? "").trim().toLowerCase();
    if (opts.checkVariantSku && !isValidVariantMkSku(vSku, mainSku)) {
      return { ok: false, rule: "invalid_variant_sku", field: `variant-${i}-sku` };
    }
    if (opts.checkFormDuplicates) {
      if (seenSkus.has(vSku)) {
        return { ok: false, rule: "duplicate_in_form", field: `variant-${i}-sku` };
      }
      seenSkus.add(vSku);
    }

    const vBarcode = (v.barcode ?? "").trim();
    if (opts.checkVariantBarcode && !isValidEan13(vBarcode)) {
      return { ok: false, rule: "invalid_barcode", field: `variant-${i}-barcode` };
    }
    if (opts.checkFormDuplicates) {
      if (seenBarcodes.has(vBarcode)) {
        return { ok: false, rule: "duplicate_in_form", field: `variant-${i}-barcode` };
      }
      seenBarcodes.add(vBarcode);
    }

    for (const f of VARIANT_NUMBER_FIELDS) {
      if (isBadNumber(v[f])) return { ok: false, rule: "invalid_number", field: `variant-${i}-${f}` };
      if (isNegativeNumber(v[f])) return { ok: false, rule: "negative_number", field: `variant-${i}-${f}` };
    }
  }

  return { ok: true };
}
