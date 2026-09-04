// TALABAT.PKGJOB — job error codes + owner-facing Arabic messages (PURE, tiny).
//
// Shared by the engine, the routes and the CLIENT component. The UI renders
// ONLY these fixed strings (plus a short reference id) — never a raw response
// body, so an upstream HTML error page (e.g. a platform FUNCTION_INVOCATION_
// TIMEOUT page) can never appear inside the page.

export type TalabatJobErrorCode =
  | "no_exportable_rows"
  | "filename_collision"
  | "integrity_failed"
  | "generation_failed"
  /**
   * STEP 76 — RECOVERABLE. Every image is packaged and the archive is durable
   * in storage; only the cheap finalization tail (mapping sync / audit) did not
   * finish. The job keeps its parts and resumes from that stage — it must NEVER
   * restart image download, and its parts must NEVER be cleaned.
   */
  | "upload_incomplete";

/** Failure codes that keep their durable parts and can resume in place. */
export const TALABAT_RECOVERABLE_ERROR_CODES: readonly string[] = ["upload_incomplete"];

/** True when a failed job may resume rather than being cleaned and restarted. */
export function isRecoverableTalabatJobError(code: string | null | undefined): boolean {
  return TALABAT_RECOVERABLE_ERROR_CODES.includes(String(code ?? ""));
}

export type TalabatJobUiErrorCode =
  | TalabatJobErrorCode
  | "jobs_unavailable"
  | "job_not_found"
  | "conflict"
  | "forbidden"
  | "stale_abandoned"
  | "network";

/** Owner-facing Arabic messages — the UI must NEVER render a raw response body. */
export const TALABAT_JOB_ERROR_AR: Record<TalabatJobUiErrorCode, string> = {
  no_exportable_rows: "لا توجد صفوف جاهزة للتصدير إلى طلبات.",
  filename_collision: "تعارض في أسماء ملفات الصور — راجع تكرار SKU قبل التوليد.",
  integrity_failed: "فشل فحص سلامة الحزمة — لم يُولَّد أي ملف.",
  generation_failed: "تعذّر توليد الحزمة — أعد المحاولة، وسيُستأنف التوليد من حيث توقف.",
  // STEP 76 — the images are safe; only the finalization tail remains.
  upload_incomplete: "فشل رفع الحزمة النهائية. الصور محفوظة ولن تحتاج إلى إعادة تجهيزها. يمكنك متابعة الرفع من حيث توقف.",
  jobs_unavailable: "خدمة توليد الحزم غير مهيأة بعد (ترحيل قاعدة البيانات غير مُطبَّق).",
  job_not_found: "مهمة التوليد غير موجودة أو انتهت صلاحيتها.",
  conflict: "توليد آخر قيد التنفيذ لهذه الحزمة — انتظر لحظة ثم أعد المحاولة.",
  // STEP 75 — a job abandoned mid-flight and reaped by a later start. Its
  // temporary parts were cleaned; a fresh generation can be started safely.
  stale_abandoned: "توقّف توليد سابق دون إكمال وتم إنهاؤه — يمكنك بدء توليد جديد.",
  forbidden: "لا تملك صلاحية توليد حزمة طلبات.",
  network: "تعذّر الاتصال بالخادم — الرجاء المحاولة مرة أخرى.",
};

/** The safe Arabic message for a code (unknown codes fall back to network). */
export function talabatJobErrorMessageAr(code: string | null | undefined): string {
  return TALABAT_JOB_ERROR_AR[(code ?? "network") as TalabatJobUiErrorCode] ?? TALABAT_JOB_ERROR_AR.network;
}

/** The engine/job stages, in the order the UI displays them. */
export const TALABAT_JOB_STAGES = [
  "PREPARING",
  "BUILDING_WORKBOOK",
  "DOWNLOADING_IMAGES",
  "BUILDING_ARCHIVE",
  "UPLOADING_ARTIFACT",
  "SYNCING_MAPPINGS",
  "FINALIZING",
  "COMPLETED",
] as const;

export type TalabatJobStage = (typeof TALABAT_JOB_STAGES)[number];

/** Arabic label for each stage — the only stage text the UI ever renders. */
export const TALABAT_JOB_STAGE_AR: Record<TalabatJobStage, string> = {
  PREPARING: "التحضير",
  BUILDING_WORKBOOK: "بناء ملف الإكسل",
  DOWNLOADING_IMAGES: "تجهيز الصور",
  BUILDING_ARCHIVE: "بناء الأرشيف",
  UPLOADING_ARTIFACT: "رفع الملف",
  SYNCING_MAPPINGS: "مزامنة الربط",
  FINALIZING: "اللمسات الأخيرة",
  COMPLETED: "اكتمل",
};
