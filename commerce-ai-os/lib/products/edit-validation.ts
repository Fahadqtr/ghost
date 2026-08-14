// Pure validation + fixed Arabic messages for the V2 product editor
// (Phase UI.4). The RULES now live in the shared ./variant-validate layer
// (UX.4E-3); this module keeps the edit-specific concern: the fixed Arabic
// message vocabulary, the `edit-` field-id prefix, and the failure-mapping
// helper. As of UX.4E-3 Edit enforces the SAME SKU / barcode / EAN-13 /
// within-form-duplicate rules Create already enforced (validation parity) —
// the only intended behavior change — on top of the existing DB row-id guard.
// Every user-facing string here is a fixed constant: no field value, database
// text, SQLSTATE, uuid or internal name is ever interpolated. Runs identically
// in the browser (pre-submit focus) and in the server action (the authority).

import type { ProductInput } from "./product-save";
import {
  EDIT_PROFILE,
  validateProductFields,
  type ValidationRule,
} from "./variant-validate.ts";

export const EDIT_MESSAGES = {
  not_signed_in: "غير مسجّل الدخول.",
  invalid_input: "بيانات المنتج غير صالحة — تحقق من الحقول وحاول مجددًا.",
  name_required: "أدخل اسم المنتج بالعربية أو الإنجليزية.",
  invalid_number: "قيمة رقمية غير صالحة — تحقق من السعر والتكلفة والكمية.",
  negative_number: "القيم الرقمية لا يمكن أن تكون سالبة.",
  // Parity rules adopted in UX.4E-3 — same fixed text as the creator uses.
  invalid_sku: "صيغة SKU غير صحيحة — الشكل المطلوب مثل: mk123.",
  invalid_variant_sku: "صيغة SKU الخيار غير صحيحة — الشكل المطلوب مثل: mk123-1.",
  invalid_barcode: "الباركود غير صالح — يجب أن يكون EAN-13 صحيحًا.",
  duplicate_in_form: "يوجد SKU أو باركود مكرر داخل النموذج نفسه.",
  duplicate_variant_row: "تعذّر حفظ الخيارات — حدّث الصفحة وحاول مجددًا.",
  duplicate_identity: "منتج آخر يستخدم نفس SKU أو الباركود — استخدم قيمة مختلفة.",
  product_update_failed: "تعذّر حفظ المنتج — حاول مجددًا.",
  inventory_sync_failed: "تم حفظ المنتج لكن تعذّر تحديث كمية المخزون — حاول مجددًا.",
  inventory_missing: "تم حفظ المنتج لكن لا يوجد صف مخزون له — تعذّر تحديث الكمية.",
  stock_managed_by_shelves: "مخزون هذا المنتج يُدار من الرفوف؛ عدّل الكمية من إدارة الرفوف.",
  stock_managed_by_variants: "مخزون هذا المنتج يُحسب من الخيارات؛ عدّل كمية كل خيار.",
  load_failed: "تعذر تحميل بيانات المنتج للتعديل.",
  not_found: "لا يوجد منتج بهذا المعرّف.",
  saved: "تم حفظ التغييرات.",
} as const;

export type EditValidationResult =
  | { ok: true }
  | {
      ok: false;
      message: string;
      /** DOM id of the first offending field, for focus. Fixed vocabulary only. */
      field: string;
    };

/** Shared rule → the fixed Arabic message the editor shows for it. */
const RULE_MESSAGE: Record<ValidationRule, string> = {
  name_required: EDIT_MESSAGES.name_required,
  category_required: EDIT_MESSAGES.invalid_input, // never emitted (edit profile off)
  invalid_sku: EDIT_MESSAGES.invalid_sku,
  invalid_barcode: EDIT_MESSAGES.invalid_barcode,
  invalid_variant_sku: EDIT_MESSAGES.invalid_variant_sku,
  duplicate_in_form: EDIT_MESSAGES.duplicate_in_form,
  duplicate_variant_row: EDIT_MESSAGES.duplicate_variant_row,
  invalid_number: EDIT_MESSAGES.invalid_number,
  negative_number: EDIT_MESSAGES.negative_number,
};

/**
 * Validate the edit payload before any write. The save core re-validates ids
 * against the authoritative set and the RPC re-validates everything again —
 * this layer exists so the common mistakes fail instantly with a precise,
 * fixed message and a focusable field id. Delegates every rule to the shared
 * ./variant-validate engine (Edit profile: Create-parity on SKU/barcode/EAN +
 * within-form duplicates, plus the existing DB row-id guard).
 */
export function validateProductEditInput(input: ProductInput): EditValidationResult {
  const result = validateProductFields(input, EDIT_PROFILE);
  if (result.ok) return { ok: true };
  return { ok: false, message: RULE_MESSAGE[result.rule], field: `edit-${result.field}` };
}

/**
 * Map a failed updateProductCore result to the fixed Arabic message the V2
 * editor shows. variant_sync messages are ALREADY the fixed Arabic constants
 * from the save core (shelf-stock guard, channel-mapping guard, generic), so
 * they pass through; every other stage maps to a constant here — the legacy
 * English/database-derived text in `message` is never surfaced in V2.
 */
export function editFailureMessage(failure: {
  stage: "invalid_input" | "product_update" | "inventory_sync" | "variant_sync";
  message: string;
  duplicateIdentity?: boolean;
  reason?: string;
}): string {
  switch (failure.stage) {
    case "invalid_input":
      return EDIT_MESSAGES.invalid_input;
    case "product_update":
      return failure.duplicateIdentity === true
        ? EDIT_MESSAGES.duplicate_identity
        : EDIT_MESSAGES.product_update_failed;
    case "inventory_sync":
      // INV.4D: a precise, safe message for the known Inventory Engine reasons.
      switch (failure.reason) {
        case "inventory_missing":
          return EDIT_MESSAGES.inventory_missing;
        case "product_has_shelf_rows":
          return EDIT_MESSAGES.stock_managed_by_shelves;
        case "product_has_variants":
          return EDIT_MESSAGES.stock_managed_by_variants;
        default:
          return EDIT_MESSAGES.inventory_sync_failed;
      }
    case "variant_sync":
      return failure.message;
    default:
      return EDIT_MESSAGES.product_update_failed;
  }
}
