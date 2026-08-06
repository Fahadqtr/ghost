// Pure validation + fixed Arabic messages for the V2 product editor
// (Phase UI.4). No imports, no I/O — runs identically in the browser (pre-
// submit, for focusing the first bad field) and in the server action (the
// authority). Every user-facing string here is a fixed constant: no field
// value, database text, SQLSTATE, uuid or internal name is ever interpolated.

import type { ProductInput } from "./product-save";

export const EDIT_MESSAGES = {
  not_signed_in: "غير مسجّل الدخول.",
  invalid_input: "بيانات المنتج غير صالحة — تحقق من الحقول وحاول مجددًا.",
  name_required: "أدخل اسم المنتج بالعربية أو الإنجليزية.",
  invalid_number: "قيمة رقمية غير صالحة — تحقق من السعر والتكلفة والكمية.",
  negative_number: "القيم الرقمية لا يمكن أن تكون سالبة.",
  duplicate_variant_row: "تعذّر حفظ الخيارات — حدّث الصفحة وحاول مجددًا.",
  duplicate_identity: "منتج آخر يستخدم نفس SKU أو الباركود — استخدم قيمة مختلفة.",
  product_update_failed: "تعذّر حفظ المنتج — حاول مجددًا.",
  inventory_sync_failed: "تم حفظ المنتج لكن تعذّر تحديث كمية المخزون — حاول مجددًا.",
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

/** Blank is allowed (means NULL); anything else must be a finite number. */
function badNumber(v: string): boolean {
  const t = (v ?? "").trim();
  if (t === "") return false;
  const n = Number(t);
  return !Number.isFinite(n);
}

/** Blank is allowed; anything else must be a finite number >= 0. */
function negativeNumber(v: string): boolean {
  const t = (v ?? "").trim();
  if (t === "") return false;
  const n = Number(t);
  return Number.isFinite(n) && n < 0;
}

function isBlank(v: string): boolean {
  return (v ?? "").trim() === "";
}

const PRODUCT_NUMBER_FIELDS = ["price", "discount_price", "cost", "stock_quantity"] as const;
const VARIANT_NUMBER_FIELDS = ["price", "stock_quantity"] as const;

/**
 * Validate the edit payload before any write. The save core re-validates ids
 * against the authoritative set and the RPC re-validates everything again —
 * this layer exists so the common mistakes fail instantly with a precise,
 * fixed message and a focusable field id.
 */
export function validateProductEditInput(input: ProductInput): EditValidationResult {
  if (isBlank(input.name_ar) && isBlank(input.name_en)) {
    return { ok: false, message: EDIT_MESSAGES.name_required, field: "edit-name_ar" };
  }

  for (const f of PRODUCT_NUMBER_FIELDS) {
    if (badNumber(input[f])) {
      return { ok: false, message: EDIT_MESSAGES.invalid_number, field: `edit-${f}` };
    }
    if (negativeNumber(input[f])) {
      return { ok: false, message: EDIT_MESSAGES.negative_number, field: `edit-${f}` };
    }
  }

  const seenIds = new Set<string>();
  const variants = Array.isArray(input.variants) ? input.variants : [];
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    const id = typeof v.id === "string" ? v.id.trim() : "";
    if (id.length > 0) {
      if (seenIds.has(id)) {
        return { ok: false, message: EDIT_MESSAGES.duplicate_variant_row, field: "edit-variants" };
      }
      seenIds.add(id);
    }
    for (const f of VARIANT_NUMBER_FIELDS) {
      if (badNumber(v[f])) {
        return { ok: false, message: EDIT_MESSAGES.invalid_number, field: `edit-variant-${i}-${f}` };
      }
      if (negativeNumber(v[f])) {
        return { ok: false, message: EDIT_MESSAGES.negative_number, field: `edit-variant-${i}-${f}` };
      }
    }
  }

  return { ok: true };
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
}): string {
  switch (failure.stage) {
    case "invalid_input":
      return EDIT_MESSAGES.invalid_input;
    case "product_update":
      return failure.duplicateIdentity === true
        ? EDIT_MESSAGES.duplicate_identity
        : EDIT_MESSAGES.product_update_failed;
    case "inventory_sync":
      return EDIT_MESSAGES.inventory_sync_failed;
    case "variant_sync":
      return failure.message;
    default:
      return EDIT_MESSAGES.product_update_failed;
  }
}
