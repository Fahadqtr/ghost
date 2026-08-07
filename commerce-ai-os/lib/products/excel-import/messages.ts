// Catalog Excel import — the fixed Arabic user-facing messages (Phase UI.6).
//
// This module exists because the server-actions file (app/(v2)/v2/catalog/
// import/actions.ts) is marked "use server", and Next.js requires EVERY
// runtime export of such a file to be an async function. Exporting this
// object from there made module evaluation throw
// ("A \"use server\" file can only export async functions, found object.")
// and every action POST returned 500 before any code ran. Keep this file
// free of the "use server" directive — it is a plain constants module.
//
// Fixed text only — never parser output, raw errors, database codes,
// constraint names or stacks.

export const IMPORT_MESSAGES = {
  not_signed_in: "غير مسجّل الدخول.",
  file_missing: "أرفق ملف Excel أولًا.",
  file_type: "نوع الملف غير مدعوم — المطلوب ملف ‎.xlsx.",
  file_too_large: "حجم الملف أكبر من المسموح (15 ميغابايت).",
  file_empty: "الملف فارغ.",
  file_unreadable: "تعذر قراءة الملف — تأكد أنه ملف Excel سليم.",
  no_sheet: "لا توجد ورقة صالحة في الملف.",
  sheet_required: "يجب اختيار ورقة.",
  sheet_not_found: "الورقة المحددة غير موجودة.",
  too_many_rows: "عدد الصفوف أكبر من المسموح (5000 صف).",
  too_many_columns: "عدد الأعمدة أكبر من المسموح (200 عمود).",
  mapping_invalid: "ربط الأعمدة غير صالح.",
  mapping_identifier: "يجب ربط عمود SKU أو الباركود على الأقل.",
  mapping_duplicate: "لا يمكن ربط العمود نفسه بأكثر من حقل.",
  scan_failed: "تعذّر فحص الكتالوج — حاول مجددًا.",
  parent_missing: "المنتج الأب غير موجود.",
  conflict_ids: "SKU والباركود يشيران إلى سجلين مختلفين.",
  dup_in_file: "المعرّف مكرر داخل الملف.",
  dup_in_db: "المعرّف مكرر في قاعدة البيانات.",
  changed_after_preview: "تغير السجل بعد المعاينة — أعد الفحص.",
  update_product_failed: "فشل تحديث المنتج.",
  update_variant_failed: "فشل تحديث الخيار.",
  create_product_failed: "فشل إنشاء المنتج.",
  create_variant_failed: "فشل إنشاء الخيار.",
  duplicate_blocks_create: "يوجد منتج مطابق في الكتالوج — لا يمكن الإنشاء.",
  invalid_barcode: "الباركود غير صالح.",
  name_required_create: "أدخل اسم المنتج بالعربية أو الإنجليزية.",
  unknown_category: "الفئة غير موجودة.",
  needs_image_note: "أُنشئ بدون صورة — أكمل الصورة من محرر المنتج.",
  // Safety net: fixed text + a safe internal code only — NEVER parser text,
  // raw errors, database codes or stacks.
  unexpected_inspect: "تعذّر قراءة الملف — أعد المحاولة. (رمز داخلي: IMPORT-SRV-01)",
  unexpected_preview: "تعذّر تحليل الملف — أعد المحاولة. (رمز داخلي: IMPORT-SRV-02)",
  unexpected_apply: "تعذّر تنفيذ العملية — أعد المحاولة. (رمز داخلي: IMPORT-SRV-03)",
} as const;
