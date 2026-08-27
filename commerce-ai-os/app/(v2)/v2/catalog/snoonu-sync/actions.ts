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
  recommendSnoonuImportMode,
  spiLike,
  type SnoonuImportMode,
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
  mode_required: "اختر وضع الاستيراد صراحةً (مزامنة كاملة أو تحديث جزئي).",
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

/** the EXPLICIT mode field — anything else fails closed (never a default). */
function readMode(formData: FormData): SnoonuImportMode | null {
  const v = formData.get("mode");
  return v === "FULL" || v === "PARTIAL" ? v : null;
}

export interface SnoonuSyncPreviewVM {
  fileName: string;
  columns: { header: string; label: string | null }[];
  /** schema-based recommendation ONLY — the human chose `plan.mode`. */
  recommendedMode: SnoonuImportMode;
  plan: SnoonuSyncPlan;
}

export async function previewSnoonuSyncAction(
  formData: FormData,
): Promise<{ data: SnoonuSyncPreviewVM } | { error: string }> {
  const writer = await requireMalakWriter();
  if (!writer.ok) return { error: writer.error };
  const mode = readMode(formData);
  if (!mode) return { error: ERR.mode_required };
  const parsed = await parseSnoonuFile(formData);
  if (!parsed.ok) return { error: parsed.error };
  const plan = await previewSnoonuSyncPlan(mode, parsed.rows.rows, parsed.rows.emptySpiRows);
  if (!plan) return { error: ERR.context_failed };
  const { SNOONU_SYNC_FIELD_LABEL } = await import("@/lib/snoonu/sync");
  return {
    data: {
      fileName: parsed.fileName,
      columns: parsed.columns.map((c) => ({ header: c.header, label: c.field ? SNOONU_SYNC_FIELD_LABEL[c.field] : null })),
      recommendedMode: recommendSnoonuImportMode(parsed.columns),
      plan,
    },
  };
}

export async function applySnoonuSyncAction(
  formData: FormData,
): Promise<{ data: SnoonuApplyResult } | { error: string }> {
  // OWNER ONLY — the explicit apply confirmation. Nothing writes before this.
  // The plan is REBUILT server-side in the EXPLICIT mode (client
  // classifications are never trusted; collisions and zero-price safety are
  // re-detected here) and drift fails closed on the fingerprint.
  const owner = await requireOwner();
  if (!owner.ok) return { error: owner.error };
  const mode = readMode(formData);
  if (!mode) return { error: ERR.mode_required };
  const fingerprint = formData.get("fingerprint");
  if (typeof fingerprint !== "string" || fingerprint.length !== 64) return { error: ERR.plan_changed };
  const overridesRaw = formData.get("zeroPriceOverrides");
  let zeroPriceOverrides: string[] = [];
  if (typeof overridesRaw === "string" && overridesRaw !== "") {
    try {
      const arr = JSON.parse(overridesRaw);
      zeroPriceOverrides = Array.isArray(arr) ? arr.filter((v): v is string => typeof v === "string").slice(0, 500) : [];
    } catch {
      return { error: ERR.plan_changed };
    }
  }
  const parsed = await parseSnoonuFile(formData);
  if (!parsed.ok) return { error: parsed.error };
  const applied = await applySnoonuSyncPlan({
    mode,
    rows: parsed.rows.rows,
    emptySpiRows: parsed.rows.emptySpiRows,
    expectedFingerprint: fingerprint,
    zeroPriceOverrides,
    sourceFileName: parsed.fileName,
    actor: owner.email,
  });
  if (!applied.ok) return { error: ERR[applied.error] };
  return { data: applied.value };
}

// ── TWO-SOURCE COMBINED PREVIEW (FULL + BULK, read-only) ────────────────────

interface ParsedSource {
  sheet: string;
  columns: SnoonuSyncColumn[];
  fileName: string;
  rows: ReturnType<typeof parseSnoonuSyncData>["rows"];
  emptySpiRows: ReturnType<typeof parseSnoonuSyncData>["emptySpiRows"];
}

/** Parse ONE uploaded workbook under a field prefix ("full" / "bulk"). */
async function parseNamedSource(
  formData: FormData,
  prefix: "full" | "bulk",
): Promise<{ ok: true; value: ParsedSource } | { ok: false; error: string } | null> {
  const file = formData.get(`${prefix}File`);
  if (!(file instanceof File) || file.size === 0) return null;
  if (file.size > MAX_IMPORT_BYTES) return { ok: false, error: ERR.file_too_big };
  const bytes = Buffer.from(await file.arrayBuffer());
  if (!looksLikeXlsx(bytes)) return { ok: false, error: ERR.file_unreadable };
  const inspected = await inspectWorkbook(bytes);
  if (inspected.status !== "ok" || inspected.sheets.length === 0) return { ok: false, error: ERR.file_unreadable };
  const requested = formData.get(`${prefix}Sheet`);
  // the BULK workbook keeps its data on a named sheet beside Instructions —
  // pick the FIRST sheet that actually carries an SPI column, never guess.
  const candidates = typeof requested === "string" && requested !== ""
    ? [requested.slice(0, 200)]
    : inspected.sheets.map((s) => s.name);
  for (const name of candidates) {
    const extracted = await extractSheetRows(bytes, name);
    if (extracted.status !== "ok") continue;
    const columns = detectSnoonuSyncColumns(extracted.headers);
    if (!columns.some((c) => c.field === "spi")) continue;
    const parsed = parseSnoonuSyncData(extracted.rows, extracted.rowNums, columns);
    return { ok: true, value: { sheet: name, columns, fileName: file.name, ...parsed } };
  }
  return { ok: false, error: ERR.no_spi };
}

export interface SnoonuCombinedPreviewVM {
  fullFile: { name: string; sheet: string } | null;
  bulkFile: { name: string; sheet: string } | null;
  plan: import("@/lib/snoonu/two-source").SnoonuCombinedPlan;
}

/** READ-ONLY combined preview of the FULL catalog + BULK update workbooks. */
export async function previewSnoonuCombinedAction(
  formData: FormData,
): Promise<{ data: SnoonuCombinedPreviewVM } | { error: string }> {
  const writer = await requireMalakWriter();
  if (!writer.ok) return { error: writer.error };
  const fullRes = await parseNamedSource(formData, "full");
  const bulkRes = await parseNamedSource(formData, "bulk");
  if (fullRes && !fullRes.ok) return { error: fullRes.error };
  if (bulkRes && !bulkRes.ok) return { error: bulkRes.error };
  const full = fullRes?.ok ? fullRes.value : null;
  const bulk = bulkRes?.ok ? bulkRes.value : null;
  if (!full && !bulk) return { error: ERR.file_required };
  const { previewSnoonuCombined } = await import("@/lib/snoonu/two-source.server");
  const plan = await previewSnoonuCombined({
    full: full ? { rows: full.rows, emptySpiRows: full.emptySpiRows } : null,
    bulk: bulk ? { rows: bulk.rows, emptySpiRows: bulk.emptySpiRows } : null,
  });
  if (!plan) return { error: ERR.context_failed };
  return {
    data: {
      fullFile: full ? { name: full.fileName, sheet: full.sheet } : null,
      bulkFile: bulk ? { name: bulk.fileName, sheet: bulk.sheet } : null,
      plan,
    },
  };
}

// ── SCOPED REPAIR (owner-only, five authorized operations) ──────────────────

/** READ-ONLY preview of the authorized repairs against live production. */
export async function previewSnoonuRepairAction(): Promise<
  { data: import("@/lib/snoonu/repair").SnoonuRepairPlanResult } | { error: string }
> {
  const owner = await requireOwner();
  if (!owner.ok) return { error: owner.error };
  const { previewSnoonuRepair } = await import("@/lib/snoonu/repair.server");
  const plan = await previewSnoonuRepair();
  if (!plan) return { error: ERR.context_failed };
  return { data: plan };
}

/** Execute the authorized repairs after the owner's explicit confirmation. */
export async function applySnoonuRepairAction(
  formData: FormData,
): Promise<{ data: import("@/lib/snoonu/repair.server").SnoonuRepairApplyResult } | { error: string }> {
  const owner = await requireOwner();
  if (!owner.ok) return { error: owner.error };
  const fingerprint = formData.get("fingerprint");
  if (typeof fingerprint !== "string" || fingerprint.length !== 64) return { error: ERR.plan_changed };
  const { applySnoonuRepair } = await import("@/lib/snoonu/repair.server");
  const res = await applySnoonuRepair({ expectedFingerprint: fingerprint, actor: owner.email });
  if (!res.ok) {
    return { error: res.error === "plan_changed" ? ERR.plan_changed : res.error === "nothing_eligible" ? "لا توجد عمليات مؤهلة للإصلاح." : ERR.context_failed };
  }
  return { data: res.value };
}

/** READ-ONLY duplicate-pair audit for IDENTITY_COLLISION cases (OWNER only).
 *  Snoonu Sync never merges — this prepares the separate resolution decision. */
export async function previewDuplicatePairAction(
  formData: FormData,
): Promise<{ data: import("@/lib/products/duplicate-resolution.server").DuplicatePairAudit } | { error: string }> {
  const owner = await requireOwner();
  if (!owner.ok) return { error: owner.error };
  const skuA = formData.get("skuA");
  const skuB = formData.get("skuB");
  if (typeof skuA !== "string" || typeof skuB !== "string" || !skuA || !skuB) return { error: ERR.not_allowed };
  const { auditDuplicatePair } = await import("@/lib/products/duplicate-resolution.server");
  const audit = await auditDuplicatePair(skuA.slice(0, 60), skuB.slice(0, 60));
  if (!audit) return { error: ERR.context_failed };
  return { data: audit };
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
