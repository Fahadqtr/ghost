// Pure validation + fixed Arabic messages for the AI product creator
// (Phase UI.5). Mirrors lib/products/edit-validation.ts: no imports beyond
// types, runs identically in the browser (focus-first-error) and in the
// server action (the authority). Every user-facing string is a fixed
// constant — no field value, database text, SQLSTATE, storage path, AI text,
// uuid or internal name is ever interpolated.

import type { ProductInput } from "./product-save";

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

function isBlank(v: string): boolean {
  return (v ?? "").trim() === "";
}
function badNumber(v: string): boolean {
  const t = (v ?? "").trim();
  if (t === "") return false;
  return !Number.isFinite(Number(t));
}
function negativeNumber(v: string): boolean {
  const t = (v ?? "").trim();
  if (t === "") return false;
  const n = Number(t);
  return Number.isFinite(n) && n < 0;
}

const MK_RE = /^mk\d+$/i;

// EAN-13 with a verified check digit. The math is inlined (6 lines) rather
// than imported from ./barcode-ean13 because this module is loaded at runtime
// by node:test AND by the client wizard — a relative runtime import would
// break node's extensionless resolution (same isolation rule as
// edit-form-state's local str/num helpers).
function isEan13(value: string): boolean {
  const s = (value ?? "").trim();
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (i % 2 === 0 ? 1 : 3) * Number(s[i]);
  return (10 - (sum % 10)) % 10 === Number(s[12]);
}

const PRODUCT_NUMBER_FIELDS = ["price", "discount_price", "cost", "stock_quantity"] as const;
const VARIANT_NUMBER_FIELDS = ["price", "stock_quantity"] as const;

/**
 * Validate the create payload before any write. The server action re-checks
 * uniqueness against the live catalog and createProductCore is all-or-nothing;
 * this layer catches the shape problems with a precise fixed message and a
 * focusable field id (ids use the `create-` prefix).
 */
export function validateAiProductInput(input: ProductInput): CreateValidationResult {
  if (isBlank(input.name_ar) && isBlank(input.name_en)) {
    return { ok: false, message: CREATE_MESSAGES.name_required, field: "create-name_ar" };
  }
  if (isBlank(input.main_category)) {
    return { ok: false, message: CREATE_MESSAGES.category_required, field: "create-main_category" };
  }
  const sku = (input.sku ?? "").trim();
  if (!MK_RE.test(sku)) {
    return { ok: false, message: CREATE_MESSAGES.invalid_sku, field: "create-sku" };
  }
  const barcode = (input.barcode ?? "").trim();
  if (!isEan13(barcode)) {
    return { ok: false, message: CREATE_MESSAGES.invalid_barcode, field: "create-barcode" };
  }
  for (const f of PRODUCT_NUMBER_FIELDS) {
    if (badNumber(input[f])) return { ok: false, message: CREATE_MESSAGES.invalid_number, field: `create-${f}` };
    if (negativeNumber(input[f])) return { ok: false, message: CREATE_MESSAGES.negative_number, field: `create-${f}` };
  }

  const mainNorm = sku.toLowerCase();
  const seenSkus = new Set<string>([mainNorm]);
  const seenBarcodes = new Set<string>([barcode]);
  const variants = Array.isArray(input.variants) ? input.variants : [];
  const variantSkuRe = new RegExp(`^${mainNorm.replace(/[.*+?^${}()|[\]\\]/g, "")}-[1-9]\\d*$`);

  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    const vSku = (v.sku ?? "").trim().toLowerCase();
    if (!variantSkuRe.test(vSku)) {
      return { ok: false, message: CREATE_MESSAGES.invalid_variant_sku, field: `create-variant-${i}-sku` };
    }
    if (seenSkus.has(vSku)) {
      return { ok: false, message: CREATE_MESSAGES.duplicate_in_form, field: `create-variant-${i}-sku` };
    }
    seenSkus.add(vSku);
    const vBarcode = (v.barcode ?? "").trim();
    if (!isEan13(vBarcode)) {
      return { ok: false, message: CREATE_MESSAGES.invalid_barcode, field: `create-variant-${i}-barcode` };
    }
    if (seenBarcodes.has(vBarcode)) {
      return { ok: false, message: CREATE_MESSAGES.duplicate_in_form, field: `create-variant-${i}-barcode` };
    }
    seenBarcodes.add(vBarcode);
    for (const f of VARIANT_NUMBER_FIELDS) {
      if (badNumber(v[f])) return { ok: false, message: CREATE_MESSAGES.invalid_number, field: `create-variant-${i}-${f}` };
      if (negativeNumber(v[f])) return { ok: false, message: CREATE_MESSAGES.negative_number, field: `create-variant-${i}-${f}` };
    }
  }
  return { ok: true };
}
