// Malikas V2 — Product Completeness (UX.4A). A THIN, form-facing wrapper over the
// existing readiness engine (lib/operations/readiness/readiness.ts). It does NOT
// re-implement any scoring or field rule: it maps the live create/edit form state
// into an OperationsProduct snapshot, delegates to computeProductReadiness, and
// re-shapes the result (percent + per-field checks) for the form widget, adding
// only a presentation "tone" band and Arabic field labels.
//
// Pure: no I/O, no AI, no DB, no clock, no mutation of the caller's state.

import { computeProductReadiness } from "../operations/readiness/readiness.ts";
import type { OperationsProduct, ReadinessCheckCode } from "../operations/shared/models.ts";

/** Presentation band ONLY — never changes readiness status semantics. */
export type CompletenessTone = "complete" | "good" | "incomplete";

/** One field row in the widget checklist — mirrors a readiness ReadinessCheck. */
export interface ProductCompletenessCheck {
  code: ReadinessCheckCode;
  label: string;
  required: boolean;
  passed: boolean;
}

export interface ProductCompletenessResult {
  /** 0..100, straight from the readiness engine (deterministic). */
  percent: number;
  tone: CompletenessTone;
  checks: ProductCompletenessCheck[];
}

/** Form-facing input — the subset of fields both the create and edit forms hold.
 *  `price` is a string in both forms; `hasImage` abstracts create (a picked file,
 *  not yet uploaded) vs edit (a persisted image_url). */
export interface ProductCompletenessInput {
  nameAr?: string | null;
  nameEn?: string | null;
  sku?: string | null;
  barcode?: string | null;
  price?: string | number | null;
  /** the product's category (main_category in both forms). */
  category?: string | null;
  brandId?: string | null;
  descriptionAr?: string | null;
  descriptionEn?: string | null;
  /** true when an image is present (create: a selected file; edit: image_url set). */
  hasImage?: boolean;
  variantCount?: number;
  expectsVariants?: boolean;
}

/** Arabic FIELD labels for the checklist (not the readiness reason messages). */
export const COMPLETENESS_LABELS: Record<ReadinessCheckCode, string> = {
  name: "الاسم",
  image: "الصورة",
  sku: "SKU",
  barcode: "الباركود",
  price: "السعر",
  category: "التصنيف",
  variants: "الخيارات",
  description: "الوصف",
  brand: "البراند",
};

/** Presentation only: 100 ⇒ complete, 70–99 ⇒ good, else incomplete. */
export function completenessTone(percent: number): CompletenessTone {
  if (percent >= 100) return "complete";
  if (percent >= 70) return "good";
  return "incomplete";
}

/** Parse the form's string price into readiness' number|null (blank/NaN ⇒ null). */
function toPrice(v: string | number | null | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = Number.parseFloat(v.trim());
  return Number.isFinite(n) ? n : null;
}

/** Map form state → OperationsProduct and delegate to the readiness engine.
 *  approval/platformStatus are irrelevant here (they only drive readiness STATUS,
 *  not the percent or the field checks the widget shows) — set to "". */
export function computeProductCompleteness(input: ProductCompletenessInput): ProductCompletenessResult {
  const snapshot: OperationsProduct = {
    id: "",
    sku: input.sku ?? null,
    barcode: input.barcode ?? null,
    nameAr: input.nameAr ?? null,
    nameEn: input.nameEn ?? null,
    descriptionAr: input.descriptionAr ?? null,
    descriptionEn: input.descriptionEn ?? null,
    brandId: input.brandId ?? null,
    category: input.category ?? null,
    price: toPrice(input.price),
    imageUrl: input.hasImage ? "1" : null,
    approval: "",
    platformStatus: "",
    variantCount: input.variantCount ?? 0,
    expectsVariants: input.expectsVariants,
  };

  const readiness = computeProductReadiness(snapshot);

  return {
    percent: readiness.percent,
    tone: completenessTone(readiness.percent),
    checks: readiness.checks.map((c) => ({
      code: c.code,
      label: COMPLETENESS_LABELS[c.code],
      required: c.required,
      passed: c.passed,
    })),
  };
}
