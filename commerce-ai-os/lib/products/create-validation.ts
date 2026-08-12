// Pure validation + fixed Arabic messages for the AI product creator
// (Phase UI.5). The RULES now live in the shared ./variant-validate layer
// (UX.4E-3) so Create, Edit, and Import cannot drift; this module keeps only
// the create-specific concern: the fixed Arabic message vocabulary and the
// `create-` field-id prefix. Every user-facing string is a fixed constant — no
// field value, database text, SQLSTATE, storage path, AI text, uuid or internal
// name is ever interpolated. Runs identically in the browser (focus-first-error)
// and in the server action (the authority).

import type { ProductInput } from "./product-save";
import {
  CREATE_PROFILE,
  validateProductFields,
  type ValidationRule,
} from "./variant-validate.ts";

export const CREATE_MESSAGES = {
  not_signed_in: "غير مسجّل الدخول.",
  invalid_input: "بيانات المنتج غير صالحة — تحقق من الحقول وحاول مجددًا.",
  name_required: "أدخل اسم المنتج بالعربية أو الإنجليزية.",
  invalid_number: "قيمة رقمية غير صالحة — تحقق من السعر والتكلفة والكمية.",
  negative_number: "القيم الرقمية لا يمكن أن تكون سالبة.",
  invalid_sku: "صيغة SKU غير صحيحة — الشكل المطلوب مثل: mk123.",
  invalid_variant_sku: "صيغة SKU الخيار غير صحيحة — الشكل المطلوب مثل: mk123-1.",
  invalid_barcode: "الباركود غير صالح — يجب أن يكون EAN-13 صحيحًا.",
  duplicate_in_form: "يوجد SKU أو باركود مكرر داخل النموذج نفسه.",
  category_required: "اختر تصنيفًا من القائمة.",
  image_required: "أضف صورة المنتج أولًا.",
  image_type: "نوع الصورة غير مدعوم — استخدم JPG أو PNG أو WEBP.",
  image_too_large: "حجم الصورة كبير جدًا — الحد الأقصى 8 ميغابايت.",
  analyze_failed: "تعذّر تحليل الصورة — حاول مجددًا أو غيّر الصورة.",
  ai_disabled: "ميزة الذكاء غير مفعّلة حاليًا.",
  identity_scan_failed: "تعذّر فحص الكتالوج — حاول مجددًا.",
  sku_taken: "رقم SKU لم يعد متاحًا — تم تحديث الرقم، راجع البيانات واحفظ مجددًا.",
  barcode_taken: "الباركود لم يعد متاحًا — تم توليد باركود جديد، راجع واحفظ مجددًا.",
  duplicate_exact: "يوجد منتج مطابق في الكتالوج — لا يمكن الحفظ.",
  image_upload_failed: "تعذّر رفع الصورة — لم يتم إنشاء المنتج.",
  image_name_taken: "توجد صورة بهذا الاسم في التخزين — حدّث SKU وحاول مجددًا.",
  create_failed: "تعذّر إنشاء المنتج — لم يتم حفظ أي شيء.",
  variant_create_failed: "تعذّر حفظ الخيارات — لم يتم إنشاء المنتج.",
  cleanup_failed: "تعذّر إنشاء المنتج وتعذّر التراجع الكامل — راجع الكتالوج قبل إعادة المحاولة.",
  image_cleanup_failed: "تعذّر إنشاء المنتج، وبقيت صورة تحتاج مراجعة يدوية في التخزين.",
  cleanup_note: "تم التراجع عن العملية بالكامل.",
  created: "تم إنشاء المنتج.",
} as const;

export type CreateValidationResult =
  | { ok: true }
  | { ok: false; message: string; field: string };

/** Shared rule → the fixed Arabic message the creator shows for it. */
const RULE_MESSAGE: Record<ValidationRule, string> = {
  name_required: CREATE_MESSAGES.name_required,
  category_required: CREATE_MESSAGES.category_required,
  invalid_sku: CREATE_MESSAGES.invalid_sku,
  invalid_barcode: CREATE_MESSAGES.invalid_barcode,
  invalid_variant_sku: CREATE_MESSAGES.invalid_variant_sku,
  duplicate_in_form: CREATE_MESSAGES.duplicate_in_form,
  duplicate_variant_row: CREATE_MESSAGES.duplicate_in_form, // never emitted (create profile off)
  invalid_number: CREATE_MESSAGES.invalid_number,
  negative_number: CREATE_MESSAGES.negative_number,
};

/**
 * Validate the create payload before any write. The server action re-checks
 * uniqueness against the live catalog and createProductCore is all-or-nothing;
 * this layer catches the shape problems with a precise fixed message and a
 * focusable field id (ids use the `create-` prefix). Delegates every rule to
 * the shared ./variant-validate engine (Create profile).
 */
export function validateAiProductInput(input: ProductInput): CreateValidationResult {
  const result = validateProductFields(input, CREATE_PROFILE);
  if (result.ok) return { ok: true };
  return { ok: false, message: RULE_MESSAGE[result.rule], field: `create-${result.field}` };
}
