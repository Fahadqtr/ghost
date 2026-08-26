// RAFEEQ.PKGJOB — job error codes + owner-facing Arabic messages (PURE, tiny).
//
// Shared by the engine, the routes, and the CLIENT component. The UI renders
// ONLY these fixed strings (plus a short reference id) — never a raw response
// body, so an upstream HTML error page can never appear inside the page.

export type RafeeqJobErrorCode =
  | "no_exportable_rows"
  | "filename_collision"
  | "integrity_failed"
  | "generation_failed";

export type RafeeqJobUiErrorCode = RafeeqJobErrorCode | "jobs_unavailable" | "job_not_found" | "conflict" | "network";

/** Owner-facing Arabic messages — the UI must NEVER render a raw response body. */
export const RAFEEQ_JOB_ERROR_AR: Record<RafeeqJobUiErrorCode, string> = {
  no_exportable_rows: "لا توجد صفوف منتجات جاهزة للتصدير.",
  filename_collision: "تعارض في أسماء ملفات الصور — راجع تكرار SKU قبل التوليد.",
  integrity_failed: "فشل فحص سلامة الحزمة — لم يُولَّد أي ملف.",
  generation_failed: "تعذّر توليد الحزمة — أعد المحاولة، وسيُستأنف التوليد من حيث توقف.",
  jobs_unavailable: "خدمة توليد الحزم غير مهيأة بعد (ترحيل قاعدة البيانات غير مُطبَّق).",
  job_not_found: "مهمة التوليد غير موجودة أو انتهت صلاحيتها.",
  conflict: "توليد آخر قيد التنفيذ لهذه الحزمة — انتظر لحظة ثم أعد المحاولة.",
  network: "تعذّر الاتصال بالخادم — الرجاء المحاولة مرة أخرى.",
};

/** The safe Arabic message for a code (unknown codes fall back to network). */
export function rafeeqJobErrorMessageAr(code: string | null | undefined): string {
  return RAFEEQ_JOB_ERROR_AR[(code ?? "network") as RafeeqJobUiErrorCode] ?? RAFEEQ_JOB_ERROR_AR.network;
}
