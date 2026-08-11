// UX.4D-2 — form adapter for the AI proposal layer. PURE — no I/O, no model,
// no DB. It bridges the proposal's camelCase content fields to the edit form's
// snake_case scalar keys, resolves `brand` (a raw string) to a brand_id via the
// shared matcher, and produces the scalar patch to apply — reusing the pure
// applyProductGenerationProposal for the fill-missing / overwrite-selected
// decision (the UI never re-implements fill logic).

import {
  PRODUCT_GENERATION_FIELDS,
  applyProductGenerationProposal,
  type ProductGenerationField,
  type ProductGenerationProposal,
} from "./product-generation.ts";
import { matchBrandId, type BrandOption } from "./brand-match.ts";

/** Content fields (excluding `brand`) → edit-form scalar key. `brand` is handled
 *  separately because the form stores a resolved `brand_id`, not a name. */
export const PROPOSAL_SCALAR_MAP: Record<Exclude<ProductGenerationField, "brand">, string> = {
  nameAr: "name_ar",
  nameEn: "name_en",
  descriptionAr: "description_ar",
  descriptionEn: "description_en",
  mainCategory: "main_category",
  subCategory: "sub_category",
  productType: "product_type",
  color: "color",
  size: "size",
  keywordsAr: "keywords_ar",
  keywordsEn: "keywords_en",
};

/** Arabic labels for the proposal preview (display only). */
export const PROPOSAL_FIELD_LABELS: Record<ProductGenerationField, string> = {
  nameAr: "الاسم (عربي)",
  nameEn: "الاسم (إنجليزي)",
  descriptionAr: "الوصف (عربي)",
  descriptionEn: "الوصف (إنجليزي)",
  brand: "العلامة التجارية",
  mainCategory: "التصنيف الرئيسي",
  subCategory: "التصنيف الفرعي",
  productType: "نوع المنتج",
  color: "اللون",
  size: "الحجم",
  keywordsAr: "كلمات مفتاحية (عربي)",
  keywordsEn: "كلمات مفتاحية (إنجليزي)",
};

function isBlank(v: unknown): boolean {
  return typeof v !== "string" || v.trim() === "";
}

export interface FillFormOptions {
  mode?: "fill-missing" | "overwrite-selected";
  /** In overwrite-selected, the proposal fields the user explicitly chose. */
  fields?: readonly ProductGenerationField[];
}

export interface FillFormPlan {
  /** Scalar patch (snake_case key → new value) to merge into the form state. */
  patch: Record<string, string>;
  /** Scalar keys that changed (includes "brand_id" when the brand resolved). */
  applied: string[];
  /** Proposal fields offered but not applied. */
  skipped: ProductGenerationField[];
  /** True when the proposal is low-confidence — the UI should require review. */
  reviewRequired: boolean;
  /** True when proposal.brand resolved to a real brand_id. */
  brandMatched: boolean;
}

/**
 * Plan the scalar patch for applying a proposal to the current form scalars.
 *
 * Content fields go through applyProductGenerationProposal (fill-missing default,
 * or overwrite-selected for explicit fields) in the proposal's own field space,
 * then map back to scalar keys. `brand` is resolved separately: the raw brand
 * string is matched to a brand_id (exact, case-insensitive) and applied only when
 * (a) it matched a real brand AND (b) fill-missing with an empty brand_id (and not
 * low-confidence), or overwrite-selected explicitly chose "brand". A brand that
 * does not match is never applied (no invented brand_id).
 */
export function planFillForm(
  currentScalars: Record<string, string>,
  proposal: ProductGenerationProposal,
  brands: readonly BrandOption[],
  options?: FillFormOptions,
): FillFormPlan {
  const mode = options?.mode ?? "fill-missing";
  const chosen = new Set(options?.fields ?? []);

  // Content fields (no brand) in the proposal's field space.
  const contentCurrent: Partial<Record<ProductGenerationField, string>> = {};
  for (const f of PRODUCT_GENERATION_FIELDS) {
    if (f === "brand") continue;
    const scalarKey = PROPOSAL_SCALAR_MAP[f as Exclude<ProductGenerationField, "brand">];
    contentCurrent[f] = currentScalars[scalarKey] ?? "";
  }
  // Strip brand from the content apply — brand is resolved on its own below.
  const contentProposal: ProductGenerationProposal = { ...proposal };
  delete contentProposal.brand;

  const res = applyProductGenerationProposal(contentCurrent, contentProposal, options);

  const patch: Record<string, string> = {};
  const applied: string[] = [];
  for (const f of res.applied) {
    if (f === "brand") continue;
    const scalarKey = PROPOSAL_SCALAR_MAP[f as Exclude<ProductGenerationField, "brand">];
    patch[scalarKey] = res.next[f];
    applied.push(scalarKey);
  }
  const skipped = [...res.skipped];

  // ── brand resolution (separate, never invents an id) ──
  let brandMatched = false;
  const brandName = typeof proposal.brand === "string" ? proposal.brand.trim() : "";
  if (brandName !== "") {
    const brandId = matchBrandId(brands, brandName);
    brandMatched = brandId !== "";
    const wantBrand =
      mode === "overwrite-selected"
        ? chosen.has("brand")
        : !res.reviewRequired && isBlank(currentScalars.brand_id);
    if (wantBrand && brandMatched) {
      patch.brand_id = brandId;
      applied.push("brand_id");
    } else if (!skipped.includes("brand")) {
      skipped.push("brand");
    }
  }

  return { patch, applied, skipped, reviewRequired: res.reviewRequired, brandMatched };
}
