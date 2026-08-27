"use server";

// SNOONU AVAILABILITY SYNC — server actions.
//
// One flow, three steps: upload the two workbooks, look at the READ-ONLY
// match preview, then (owner only) apply availability.
//
// The rule is membership, not quantity: a product listed in the BULK workbook
// is Out of Stock; a product in the FULL catalog that is absent from BULK is
// In Stock. No stock number, no "unavailable" literal and no FULL availability
// boolean is consulted anywhere in this path.

import { requireMalakWriter, requireOwner } from "@/lib/malak/authz";
import { inspectWorkbook, extractSheetRows, looksLikeXlsx, MAX_IMPORT_BYTES } from "@/lib/products/excel-import/parse";
import { detectSnoonuSyncColumns, parseSnoonuSyncData, type SnoonuSyncColumn } from "@/lib/snoonu/sync";
import type { SnoonuAvailabilityPlan } from "@/lib/snoonu/availability-sync";
import type { SnoonuAvailabilityApplyResult } from "@/lib/snoonu/availability-sync.server";

const ERR = {
  not_allowed: "غير مصرّح.",
  full_required: "ارفع ملف الكتالوج الكامل.",
  bulk_required: "ارفع ملف Bulk (المنتجات غير المتوفرة).",
  file_too_big: "الملف أكبر من الحد المسموح.",
  file_unreadable: "تعذّر قراءة الملف — تأكد أنه ملف xlsx صالح.",
  no_spi: "لم يُعثر على عمود SPI(UniqueIdentifier) في الملف.",
  context_failed: "تعذّر قراءة الكتالوج الحالي — حاول مرة أخرى.",
  plan_changed: "تغيّرت البيانات منذ المعاينة — أعد المعاينة ثم طبّق.",
  apply_blocked: "التطبيق محظور: يوجد SPI مكرر داخل أحد الملفين — أصلح الملف أولاً.",
  nothing_eligible: "لا توجد تغييرات في حالة التوفر — كل المنتجات في الحالة الصحيحة بالفعل.",
} as const;

interface ParsedSource {
  sheet: string;
  columns: SnoonuSyncColumn[];
  fileName: string;
  rows: ReturnType<typeof parseSnoonuSyncData>["rows"];
  emptySpiRows: ReturnType<typeof parseSnoonuSyncData>["emptySpiRows"];
}

/** Parse one uploaded workbook. The data sheet is the FIRST one carrying an
 *  SPI column — the BULK export keeps its rows beside an Instructions sheet. */
async function parseSource(
  formData: FormData,
  field: "fullFile" | "bulkFile",
): Promise<{ ok: true; value: ParsedSource } | { ok: false; error: string } | null> {
  const file = formData.get(field);
  if (!(file instanceof File) || file.size === 0) return null;
  if (file.size > MAX_IMPORT_BYTES) return { ok: false, error: ERR.file_too_big };
  const bytes = Buffer.from(await file.arrayBuffer());
  if (!looksLikeXlsx(bytes)) return { ok: false, error: ERR.file_unreadable };
  const inspected = await inspectWorkbook(bytes);
  if (inspected.status !== "ok" || inspected.sheets.length === 0) return { ok: false, error: ERR.file_unreadable };
  for (const sheet of inspected.sheets) {
    const extracted = await extractSheetRows(bytes, sheet.name);
    if (extracted.status !== "ok") continue;
    const columns = detectSnoonuSyncColumns(extracted.headers);
    if (!columns.some((c) => c.field === "spi")) continue;
    const parsed = parseSnoonuSyncData(extracted.rows, extracted.rowNums, columns);
    return { ok: true, value: { sheet: sheet.name, columns, fileName: file.name, ...parsed } };
  }
  return { ok: false, error: ERR.no_spi };
}

async function parseBoth(formData: FormData): Promise<
  { ok: true; full: ParsedSource; bulk: ParsedSource } | { ok: false; error: string }
> {
  const fullRes = await parseSource(formData, "fullFile");
  const bulkRes = await parseSource(formData, "bulkFile");
  if (fullRes && !fullRes.ok) return { ok: false, error: fullRes.error };
  if (bulkRes && !bulkRes.ok) return { ok: false, error: bulkRes.error };
  if (!fullRes?.ok) return { ok: false, error: ERR.full_required };
  if (!bulkRes?.ok) return { ok: false, error: ERR.bulk_required };
  return { ok: true, full: fullRes.value, bulk: bulkRes.value };
}

export interface SnoonuAvailabilityPreviewVM {
  fullFile: { name: string; sheet: string };
  bulkFile: { name: string; sheet: string };
  plan: SnoonuAvailabilityPlan;
}

/** READ-ONLY match preview. Writes nothing. */
export async function previewSnoonuAvailabilityAction(
  formData: FormData,
): Promise<{ data: SnoonuAvailabilityPreviewVM } | { error: string }> {
  const writer = await requireMalakWriter();
  if (!writer.ok) return { error: writer.error };
  const parsed = await parseBoth(formData);
  if (!parsed.ok) return { error: parsed.error };
  const { previewSnoonuAvailability } = await import("@/lib/snoonu/availability-sync.server");
  const plan = await previewSnoonuAvailability({ full: parsed.full.rows, bulk: parsed.bulk.rows });
  if (!plan) return { error: ERR.context_failed };
  return {
    data: {
      fullFile: { name: parsed.full.fileName, sheet: parsed.full.sheet },
      bulkFile: { name: parsed.bulk.fileName, sheet: parsed.bulk.sheet },
      plan,
    },
  };
}

/** OWNER-ONLY: apply availability, and nothing else. */
export async function applySnoonuAvailabilityAction(
  formData: FormData,
): Promise<{ data: SnoonuAvailabilityApplyResult } | { error: string }> {
  const owner = await requireOwner();
  if (!owner.ok) return { error: owner.error };
  const fingerprint = formData.get("fingerprint");
  if (typeof fingerprint !== "string" || fingerprint.length !== 64) return { error: ERR.plan_changed };
  const parsed = await parseBoth(formData);
  if (!parsed.ok) return { error: parsed.error };
  const { applySnoonuAvailability } = await import("@/lib/snoonu/availability-sync.server");
  const res = await applySnoonuAvailability({
    full: parsed.full.rows,
    bulk: parsed.bulk.rows,
    expectedFingerprint: fingerprint,
    sourceFileName: parsed.bulk.fileName,
    actor: owner.email,
  });
  if (!res.ok) return { error: ERR[res.error] };
  return { data: res.value };
}
