"use server";

// SNOONU CATALOG SYNC — server actions.
//
// preview  (WRITER-gated): parse the uploaded Snoonu update workbook, detect
//          its columns (SPI primary; the store-scoped availability column is
//          recognized as التوفر في سنونو), and return the READ-ONLY plan.
// apply    (OWNER-gated): re-parse + re-plan from the same file and execute
//          ONLY when the fresh fingerprint equals the one the owner previewed
//          (drift fails closed). Nothing writes before the explicit APPLY.
// return   (WRITER-gated): the Snoonu-compatible update workbook built from
//          canonical values of all SPI-mapped products (pending sentinels
//          export blank — values are never invented).

import { requireMalakWriter, requireOwner } from "@/lib/malak/authz";
import { inspectWorkbook, extractSheetRows, looksLikeXlsx, MAX_IMPORT_BYTES } from "@/lib/products/excel-import/parse";
import {
  detectSnoonuSyncColumns,
  parseSnoonuSyncData,
  spiLike,
  type SnoonuSyncColumn,
  type SnoonuSyncPlan,
} from "@/lib/snoonu/sync";
import { previewSnoonuSyncPlan, applySnoonuSyncPlan, loadSnoonuSyncContext, type SnoonuApplyResult } from "@/lib/snoonu/sync.server";
import { buildSnoonuReturnXlsxBuffer } from "@/lib/snoonu/sync-xlsx";

const ERR = {
  not_allowed: "غير مصرّح.",
  file_required: "اختر ملف Excel أولاً.",
  file_too_big: "الملف أكبر من الحد المسموح.",
  file_unreadable: "تعذّر قراءة الملف — تأكد أنه ملف xlsx صالح.",
  sheet_required: "اختر الورقة.",
  no_spi: "لم يُعثر على عمود SPI(UniqueIdentifier) — هذا الملف ليس ملف تحديث سنونو.",
  context_failed: "تعذّر قراءة الكتالوج الحالي — حاول مرة أخرى.",
  plan_changed: "تغيّرت البيانات منذ المعاينة — أعد المعاينة ثم طبّق.",
  apply_blocked: "التطبيق محظور: يوجد SPI مكرر داخل الملف — أصلح الملف أولاً.",
} as const;

async function readWorkbookFile(formData: FormData): Promise<{ ok: true; bytes: Buffer; name: string } | { ok: false; error: string }> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: ERR.file_required };
  if (file.size > MAX_IMPORT_BYTES) return { ok: false, error: ERR.file_too_big };
  const bytes = Buffer.from(await file.arrayBuffer());
  if (!looksLikeXlsx(bytes)) return { ok: false, error: ERR.file_unreadable };
  return { ok: true, bytes, name: file.name };
}

async function parseSnoonuFile(formData: FormData): Promise<
  | { ok: true; columns: SnoonuSyncColumn[]; rows: ReturnType<typeof parseSnoonuSyncData>; fileName: string }
  | { ok: false; error: string }
> {
  const file = await readWorkbookFile(formData);
  if (!file.ok) return file;
  const inspected = await inspectWorkbook(file.bytes);
  if (inspected.status !== "ok" || inspected.sheets.length === 0) return { ok: false, error: ERR.file_unreadable };
  const requested = formData.get("sheet");
  const sheetName = typeof requested === "string" && requested !== "" ? requested.slice(0, 200) : inspected.sheets[0].name;
  const extracted = await extractSheetRows(file.bytes, sheetName);
  if (extracted.status !== "ok") return { ok: false, error: ERR.file_unreadable };
  const columns = detectSnoonuSyncColumns(extracted.headers);
  if (!columns.some((c) => c.field === "spi")) return { ok: false, error: ERR.no_spi };
  return { ok: true, columns, rows: parseSnoonuSyncData(extracted.rows, extracted.rowNums, columns), fileName: file.name };
}

export interface SnoonuSyncPreviewVM {
  fileName: string;
  columns: { header: string; label: string | null }[];
  plan: SnoonuSyncPlan;
}

export async function previewSnoonuSyncAction(
  formData: FormData,
): Promise<{ data: SnoonuSyncPreviewVM } | { error: string }> {
  const writer = await requireMalakWriter();
  if (!writer.ok) return { error: writer.error };
  const parsed = await parseSnoonuFile(formData);
  if (!parsed.ok) return { error: parsed.error };
  const plan = await previewSnoonuSyncPlan(parsed.rows.rows, parsed.rows.emptySpiRows);
  if (!plan) return { error: ERR.context_failed };
  const { SNOONU_SYNC_FIELD_LABEL } = await import("@/lib/snoonu/sync");
  return {
    data: {
      fileName: parsed.fileName,
      columns: parsed.columns.map((c) => ({ header: c.header, label: c.field ? SNOONU_SYNC_FIELD_LABEL[c.field] : null })),
      plan,
    },
  };
}

export async function applySnoonuSyncAction(
  formData: FormData,
): Promise<{ data: SnoonuApplyResult } | { error: string }> {
  // OWNER ONLY — the explicit apply confirmation. Nothing writes before this.
  const owner = await requireOwner();
  if (!owner.ok) return { error: owner.error };
  const fingerprint = formData.get("fingerprint");
  if (typeof fingerprint !== "string" || fingerprint.length !== 64) return { error: ERR.plan_changed };
  const parsed = await parseSnoonuFile(formData);
  if (!parsed.ok) return { error: parsed.error };
  const applied = await applySnoonuSyncPlan({
    rows: parsed.rows.rows,
    emptySpiRows: parsed.rows.emptySpiRows,
    expectedFingerprint: fingerprint,
    sourceFileName: parsed.fileName,
    actor: owner.email,
  });
  if (!applied.ok) return { error: ERR[applied.error] };
  return { data: applied.value };
}

/** The Snoonu-compatible update workbook (base64 xlsx) for owner re-upload. */
export async function buildSnoonuReturnFileAction(): Promise<
  { data: { base64: string; filename: string; rowCount: number } } | { error: string }
> {
  const writer = await requireMalakWriter();
  if (!writer.ok) return { error: writer.error };
  const ctx = await loadSnoonuSyncContext();
  if (!ctx) return { error: ERR.context_failed };
  const byId = new Map(ctx.canonical.map((c) => [c.id, c]));
  const records = ctx.listings
    .filter((l) => l.mappingStatus === "active" && !l.variantGrain && spiLike(l.externalId))
    .flatMap((l) => {
      const product = byId.get(l.productId);
      return product ? [{ spi: l.externalId, product }] : [];
    })
    .sort((a, b) => (a.product.sku < b.product.sku ? -1 : 1));
  const bytes = buildSnoonuReturnXlsxBuffer(records);
  return {
    data: {
      base64: Buffer.from(bytes).toString("base64"),
      filename: `snoonu-update-${new Date().toISOString().slice(0, 10)}.xlsx`,
      rowCount: records.length,
    },
  };
}
