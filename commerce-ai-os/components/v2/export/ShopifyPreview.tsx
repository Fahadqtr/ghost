"use client";

// INT.2E / INT.2E.2 — Shopify validation, publish preview, and safe publish.
//
// The read-only preview (INT.2E) plus the operator-confirmed publish workflow
// (INT.2E.2): Validate → Preview → Select Eligible → Publish Selected. It holds
// only view + selection state; it computes NO diff and executes NO Shopify call
// itself — publishing POSTs the SELECTED rows (each with the fingerprint it was
// previewed at) to the writer-gated /api/export/shopify/publish route, which
// re-reads, re-plans, and hard-stops CONFLICT/BLOCKED/UNKNOWN server-side. Only
// eligible (NEW / UPDATE_REQUIRED with a supported op) rows are ever selectable;
// creating new products requires an explicit extra confirmation.

import { useMemo, useState } from "react";
import type { ExportReasonCode } from "@/lib/export/validation";
import type { ShopifyPreviewStatus, ShopifyPlanOpType } from "@/lib/export/shopify/preview";
import { paginate, DEFAULT_PAGE_SIZE } from "@/lib/ui/pagination";
import { toggleKey, selectKeys, clearSelection, allSelected, countSelectedWithin } from "@/lib/ui/selection";
import SelectionToolbar from "@/components/v2/ui/SelectionToolbar";
import EmptyState from "@/components/v2/ui/EmptyState";

export interface ShopifyRowVM {
  id: string;
  sku: string;
  barcode: string | null;
  title: string;
  price: number | null;
  compareAtPrice: number | null;
  shopifyProductGid: string | null;
  hasVariants: boolean;
  variantCount: number;
  variantMatchedCount: number;
  hasImage: boolean;
  imageCount: number;
  status: ShopifyPreviewStatus;
  changedFields: string[];
  reasons: { code: ExportReasonCode; blocking: boolean }[];
  plannedOps: ShopifyPlanOpType[];
  /** INT.2E.2 — deterministic fingerprint of exactly what would be written. */
  fingerprint: string;
  /** INT.2E.2 — true when the row may be published (subject to server re-check). */
  eligible: boolean;
}

export interface ShopifyRunVM {
  id: string;
  status: string;
  actor: string | null;
  finishedAt: string | null;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  blockedCount: number;
  failedCount: number;
}

export interface ShopifyPreviewVM {
  shopifyAvailable: boolean;
  productsRead: number;
  canWrite: boolean;
  historyAvailable: boolean;
  recentRuns: ShopifyRunVM[];
  counts: {
    total: number;
    matched: number;
    new: number;
    updateRequired: number;
    conflict: number;
    blocked: number;
    unknown: number;
    plannedOps: Record<ShopifyPlanOpType, number>;
  };
  rows: ShopifyRowVM[];
}

type RowFilter = "ALL" | ShopifyPreviewStatus;

const STATUS_LABEL: Record<ShopifyPreviewStatus, string> = {
  MATCH: "مطابق", NEW: "جديد", UPDATE_REQUIRED: "تحديث مطلوب", CONFLICT: "تعارض", BLOCKED: "محظور", UNKNOWN: "غير معروف",
};
const STATUS_CHIP: Record<ShopifyPreviewStatus, string> = {
  MATCH: "border-emerald-200 bg-emerald-50 text-emerald-700",
  NEW: "border-sky-200 bg-sky-50 text-sky-700",
  UPDATE_REQUIRED: "border-amber-200 bg-amber-50 text-amber-700",
  CONFLICT: "border-rose-200 bg-rose-50 text-rose-700",
  BLOCKED: "border-rose-200 bg-rose-50 text-rose-700",
  UNKNOWN: "border-slate-200 bg-slate-50 text-slate-600",
};
const FIELD_LABEL: Record<string, string> = {
  title: "العنوان", description: "الوصف", image: "الصورة", price: "السعر", compareAt: "سعر قبل الخصم",
  variantSku: "SKU المتغيّر", variantBarcode: "باركود المتغيّر", variantMissing: "متغيّر ناقص في شوبي فاي",
};
const REASON_LABEL: Record<string, string> = {
  MISSING_SKU: "SKU مفقود", DUPLICATE_SKU: "SKU مكرّر", MISSING_BARCODE: "باركود مفقود", DUPLICATE_BARCODE: "باركود مكرّر",
  INVALID_BARCODE: "صيغة باركود غير قياسية", MISSING_IMAGE: "صورة مفقودة", MISSING_TITLE: "عنوان مفقود",
  MISSING_PRICE: "سعر مفقود", LIFECYCLE_NOT_ELIGIBLE: "غير مؤهّل (دورة الحياة)", IDENTITY_MISSING: "هوية مفقودة",
  IDENTITY_CONFLICT: "تعارض هوية", IDENTITY_NEEDS_REVIEW: "بحاجة لمراجعة المالك", VARIANT_NOT_READY: "متغيّر غير جاهز",
  UNSUPPORTED: "غير مدعوم",
};
const OP_LABEL: Record<ShopifyPlanOpType, string> = {
  CREATE_PRODUCT: "إنشاء منتج", UPDATE_PRODUCT: "تحديث منتج", UPDATE_VARIANT: "تحديث متغيّر",
  UPDATE_PRICE: "تحديث سعر", UPDATE_MEDIA: "تحديث صورة", NOOP: "بدون تغيير", BLOCKED: "محظور",
};
interface PublishItem { internalProductId: string; sku: string | null; result: string; error: string | null; ops: string[] }
interface PublishResponse { ok: boolean; error?: string; runStatus: string; counts: Record<string, number>; items: PublishItem[]; durablePersisted: boolean }

export default function ShopifyPreview({ vm }: { vm: ShopifyPreviewVM }) {
  const [filter, setFilter] = useState<RowFilter>("ALL");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmCreate, setConfirmCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PublishResponse | null>(null);

  const rowById = useMemo(() => new Map(vm.rows.map((r) => [r.id, r])), [vm.rows]);
  const eligibleAllKeys = useMemo(() => vm.rows.filter((r) => r.eligible).map((r) => r.id), [vm.rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return vm.rows.filter((r) => {
      if (filter !== "ALL" && r.status !== filter) return false;
      if (needle) {
        const hay = `${r.sku} ${r.title} ${r.barcode ?? ""} ${r.shopifyProductGid ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [vm.rows, filter, q]);

  const pageView = useMemo(() => paginate(filtered, page, DEFAULT_PAGE_SIZE), [filtered, page]);
  const eligiblePageKeys = useMemo(() => pageView.pageItems.filter((r) => r.eligible).map((r) => r.id), [pageView]);
  const selectedCount = countSelectedWithin(selected, eligibleAllKeys);

  const selectedRows = useMemo(() => [...selected].map((id) => rowById.get(id)).filter(Boolean) as ShopifyRowVM[], [selected, rowById]);
  const selCreate = selectedRows.filter((r) => r.status === "NEW").length;
  const selUpdate = selectedRows.filter((r) => r.status === "UPDATE_REQUIRED").length;

  const chip = (active: boolean) => `rounded-full border px-3 py-1 text-xs transition-colors ${active ? "border-brand bg-brand-light text-brand" : "border-slate-200 bg-white text-muted hover:bg-slate-50"}`;
  const opEntries = (Object.entries(vm.counts.plannedOps) as [ShopifyPlanOpType, number][]).filter(([, n]) => n > 0);

  async function publish() {
    if (busy || selectedRows.length === 0) return;
    if (selCreate > 0 && !confirmCreate) return; // explicit create confirmation required
    setBusy(true); setError(null); setResult(null);
    try {
      const res = await fetch(`/api/export/shopify/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirm: true,
          confirmCreate,
          selections: selectedRows.map((r) => ({ internalProductId: r.id, expectedFingerprint: r.fingerprint })),
        }),
      });
      const payload = (await res.json().catch(() => null)) as PublishResponse | null;
      if (!payload) { setError("تعذّر تنفيذ النشر الآن."); return; }
      setResult(payload);
      setConfirmOpen(false);
      setSelected(clearSelection());
    } catch {
      setError("تعذّر الاتصال بالخادم — الرجاء المحاولة لاحقاً.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-[11px] text-muted">
        النشر ينفّذ الخطة المعتمدة فقط — إنشاء منتج جديد (كمسودّة)، أو تحديث العنوان/السعر/إضافة صورة ناقصة. لا نشر تلقائي، لا حذف صور،
        لا كتابة مخزون. الهوية من ECL (<span dir="ltr">shopify:malikas</span>) عبر مُعرّف المنتج/المتغيّر فقط.
      </p>

      {!vm.shopifyAvailable && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          شوبي فاي غير مهيأ أو تعذّرت قراءته الآن — كل الصفوف «غير معروفة»، والنشر غير متاح.
        </div>
      )}

      {/* Dashboard counts */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        <Card value={vm.counts.total} label="إجمالي" tone="ink" />
        <Card value={vm.counts.matched} label="مطابق" tone="emerald" />
        <Card value={vm.counts.new} label="جديد" tone="sky" />
        <Card value={vm.counts.updateRequired} label="تحديثات" tone="amber" />
        <Card value={vm.counts.conflict} label="تعارضات" tone="rose" />
        <Card value={vm.counts.blocked} label="محظور" tone="rose" />
        <Card value={vm.counts.unknown} label="غير معروف" tone="slate" />
      </div>

      {/* Publish control bar */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-semibold text-ink">النشر إلى شوبي فاي</div>
          <span className="text-[11px] text-muted">قراءة شوبي فاي: {vm.productsRead} منتج · دفعة واحدة</span>
        </div>

        {opEntries.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {opEntries.map(([op, n]) => (
              <span key={op} className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-ink">{OP_LABEL[op]} · {n}</span>
            ))}
          </div>
        )}

        {vm.canWrite ? (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setSelected(selectKeys(new Set(), eligibleAllKeys))} disabled={eligibleAllKeys.length === 0}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50 disabled:opacity-40">
              تحديد كل المؤهّل ({eligibleAllKeys.length})
            </button>
            <button type="button" onClick={() => setSelected(clearSelection())} disabled={selectedCount === 0}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50 disabled:opacity-40">
              مسح التحديد
            </button>
            <span className="text-[11px] text-muted">محدّد {selectedCount} من {eligibleAllKeys.length} مؤهّل</span>
            <button type="button" onClick={() => { setConfirmCreate(false); setConfirmOpen(true); }} disabled={selectedCount === 0 || !vm.shopifyAvailable}
              className="btn-primary disabled:cursor-not-allowed disabled:opacity-50">
              نشر المحدد ({selectedCount})
            </button>
          </div>
        ) : (
          <span className="text-[11px] text-muted">🔒 النشر متاح لأصحاب صلاحية التعديل فقط.</span>
        )}

        {/* Confirm step (§15) — explicit, never one-click on load */}
        {confirmOpen && (
          <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            <div className="text-sm font-semibold">تأكيد النشر</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
              <Row label="إنشاء" value={String(selCreate)} />
              <Row label="تحديث" value={String(selUpdate)} />
              <Row label="إجمالي محدّد" value={String(selectedRows.length)} />
            </div>
            {selCreate > 0 && (
              <label className="flex items-center gap-2 pt-1">
                <input type="checkbox" checked={confirmCreate} onChange={(e) => setConfirmCreate(e.target.checked)} />
                <span>أؤكّد إنشاء {selCreate} منتج جديد في شوبي فاي (كمسودّة — لن يُنشر للعملاء تلقائياً).</span>
              </label>
            )}
            <div className="flex items-center gap-2 pt-1">
              <button type="button" onClick={publish} disabled={busy || (selCreate > 0 && !confirmCreate)}
                className="btn-primary disabled:cursor-not-allowed disabled:opacity-50">
                {busy ? "جارٍ النشر…" : "تأكيد وتنفيذ"}
              </button>
              <button type="button" onClick={() => setConfirmOpen(false)} disabled={busy} className="btn-ghost">إلغاء</button>
            </div>
          </div>
        )}

        {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700" dir="auto">{error}</div>}

        {result && (
          <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-[11px] text-emerald-900">
            <div className="text-xs font-semibold text-emerald-800">
              نتيجة النشر: {result.runStatus}{result.durablePersisted ? " · مُسجّل" : ""}
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
              <Row label="أُنشئ" value={String(result.counts.created ?? 0)} />
              <Row label="حُدّث" value={String(result.counts.updated ?? 0)} />
              <Row label="دون تغيير" value={String(result.counts.unchanged ?? 0)} />
              <Row label="محظور/تعارض" value={String((result.counts.blocked ?? 0) + (result.counts.conflict ?? 0))} />
              <Row label="قديم" value={String(result.counts.stale ?? 0)} />
              <Row label="فشل" value={String(result.counts.failed ?? 0)} />
              <Row label="يحتاج مطابقة" value={String(result.counts.needsReconciliation ?? 0)} />
              <Row label="تخطّي" value={String(result.counts.skippedUnsupported ?? 0)} />
            </div>
            <p className="text-[10px] text-emerald-800">أعد تحميل الصفحة لتحديث المعاينة بأحدث حالة من شوبي فاي.</p>
          </div>
        )}

        <p className="text-[11px] text-muted">
          النشر يعيد القراءة والتخطيط من جديد قبل أي تعديل، ويرفض أي صف تغيّرت بياناته منذ المعاينة (قديم). المخزون والإتاحة لا تُكتب من هنا.
        </p>
      </div>

      {/* Filters */}
      <div className="card flex flex-wrap items-center gap-2">
        {(["ALL", "MATCH", "NEW", "UPDATE_REQUIRED", "CONFLICT", "BLOCKED", "UNKNOWN"] as RowFilter[]).map((f) => (
          <button key={f} type="button" onClick={() => { setFilter(f); setPage(1); }} className={chip(filter === f)}>
            {f === "ALL" ? "الكل" : STATUS_LABEL[f as ShopifyPreviewStatus]}
          </button>
        ))}
        <input type="search" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="بحث SKU / اسم / GID…" className="min-w-[12rem] flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs text-ink" />
        <span className="text-[11px] text-muted">يعرض {pageView.pageItems.length} من {filtered.length}</span>
      </div>

      {vm.canWrite && selectedCount >= 0 && eligiblePageKeys.length > 0 && (
        <SelectionToolbar
          selectedCount={selectedCount}
          total={eligibleAllKeys.length}
          pageCount={eligiblePageKeys.length}
          pageAllSelected={allSelected(selected, eligiblePageKeys)}
          onSelectPage={() => setSelected((prev) => selectKeys(prev, eligiblePageKeys))}
          onSelectAllFiltered={() => setSelected((prev) => selectKeys(prev, eligibleAllKeys))}
          onClear={() => setSelected(clearSelection())}
        />
      )}

      {/* Table */}
      {filtered.length === 0 ? (
        <EmptyState title="لا توجد صفوف مطابقة" message="لا توجد منتجات مطابقة للفلاتر الحالية. جرّب تغيير الفلتر أو مسح البحث." />
      ) : (
        <>
          <div className="card overflow-x-auto p-0">
            <table className="w-full min-w-[980px] text-right text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-[11px] text-muted">
                <tr>
                  {vm.canWrite && <th className="px-3 py-2 text-center">تحديد</th>}
                  <th className="px-3 py-2 font-medium">SKU</th>
                  <th className="px-3 py-2 font-medium">المنتج</th>
                  <th className="px-3 py-2 font-medium">مُعرّف شوبي فاي / جديد</th>
                  <th className="px-3 py-2 font-medium">المتغيّرات</th>
                  <th className="px-3 py-2 font-medium">السعر</th>
                  <th className="px-3 py-2 font-medium">الصور</th>
                  <th className="px-3 py-2 font-medium">الحالة</th>
                  <th className="px-3 py-2 font-medium">التغييرات</th>
                </tr>
              </thead>
              <tbody>
                {pageView.pageItems.map((r) => {
                  const isSel = selected.has(r.id);
                  const accent = isSel ? "bg-blue-50 border-s-4 border-s-blue-400"
                    : r.status === "CONFLICT" || r.status === "BLOCKED" ? "border-s-4 border-s-rose-400"
                    : r.status === "UPDATE_REQUIRED" ? "border-s-4 border-s-amber-400"
                    : r.status === "NEW" ? "border-s-4 border-s-sky-400"
                    : r.status === "MATCH" ? "border-s-4 border-s-emerald-400"
                    : "border-s-4 border-s-slate-300";
                  return (
                    <tr key={r.id} className={`border-b border-slate-100 last:border-0 ${accent}`}>
                      {vm.canWrite && (
                        <td className="px-3 py-2 text-center">
                          {r.eligible
                            ? <input type="checkbox" checked={isSel} onChange={() => setSelected((prev) => toggleKey(prev, r.id))} aria-label={`تحديد ${r.sku}`} />
                            : <span className="text-slate-300">—</span>}
                        </td>
                      )}
                      <td className="px-3 py-2 font-mono text-[11px]" dir="ltr">{r.sku || (r.hasVariants ? <span className="text-muted">متغيّرات</span> : <span className="text-rose-600">—</span>)}</td>
                      <td className="px-3 py-2 text-ink">{r.title || <span className="text-rose-600">بدون عنوان</span>}</td>
                      <td className="px-3 py-2 font-mono text-[10px]" dir="ltr">
                        {r.shopifyProductGid
                          ? <span title={r.shopifyProductGid}>…{r.shopifyProductGid.slice(-10)}</span>
                          : r.status === "NEW" ? <span className="text-sky-600">جديد</span> : <span className="text-muted">—</span>}
                      </td>
                      <td className="px-3 py-2 tabular-nums" dir="ltr">{r.variantMatchedCount}/{r.variantCount}</td>
                      <td className="px-3 py-2" dir="ltr">
                        {r.price ?? <span className="text-amber-600">—</span>}
                        {r.compareAtPrice !== null && <span className="ms-1 text-[10px] text-muted line-through">{r.compareAtPrice}</span>}
                      </td>
                      <td className="px-3 py-2 tabular-nums" dir="ltr">{r.hasImage ? r.imageCount : <span className="text-rose-600">0</span>}</td>
                      <td className="px-3 py-2"><span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] ${STATUS_CHIP[r.status]}`}>{STATUS_LABEL[r.status]}</span></td>
                      <td className="px-3 py-2">
                        {r.status === "CONFLICT" || r.status === "BLOCKED" ? (
                          <div className="flex flex-wrap gap-1">
                            {r.reasons.filter((x) => x.blocking).map((x, i) => <span key={`${x.code}:${i}`} className="rounded bg-rose-50 px-1.5 py-0.5 text-[10px] text-rose-600">{REASON_LABEL[x.code] ?? x.code}</span>)}
                          </div>
                        ) : r.changedFields.length === 0 ? (
                          <span className="text-emerald-600">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {r.changedFields.map((f) => <span key={f} className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">{FIELD_LABEL[f] ?? f}</span>)}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between gap-2 px-1 text-xs text-muted">
            <span className="tabular-nums">{pageView.from}–{pageView.to} من {pageView.total}</span>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => setPage(pageView.page - 1)} disabled={pageView.page <= 1} className="rounded-lg border border-slate-300 px-2 py-1 hover:bg-slate-50 disabled:opacity-40">السابق</button>
              <span className="tabular-nums">{pageView.page}/{pageView.pageCount}</span>
              <button type="button" onClick={() => setPage(pageView.page + 1)} disabled={pageView.page >= pageView.pageCount} className="rounded-lg border border-slate-300 px-2 py-1 hover:bg-slate-50 disabled:opacity-40">التالي</button>
            </div>
          </div>
        </>
      )}

      {/* Durable publish history (§13) */}
      <div className="card space-y-2">
        <h2 className="text-sm font-semibold text-ink">سجل النشر</h2>
        {!vm.historyAvailable ? (
          <p className="text-[11px] text-muted">سجل النشر الدائم غير مُفعّل بعد (لم تُطبَّق هجرة <span dir="ltr">export_runs</span> على الإنتاج).</p>
        ) : vm.recentRuns.length === 0 ? (
          <p className="text-[11px] text-muted">لا توجد عمليات نشر سابقة.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-right text-[11px]">
              <thead className="text-muted"><tr>
                <th className="px-2 py-1 font-medium">الوقت</th><th className="px-2 py-1 font-medium">الحالة</th>
                <th className="px-2 py-1 font-medium">أُنشئ</th><th className="px-2 py-1 font-medium">حُدّث</th>
                <th className="px-2 py-1 font-medium">محظور</th><th className="px-2 py-1 font-medium">فشل</th><th className="px-2 py-1 font-medium">بواسطة</th>
              </tr></thead>
              <tbody>
                {vm.recentRuns.map((run) => (
                  <tr key={run.id} className="border-t border-slate-100">
                    <td className="px-2 py-1" dir="ltr">{run.finishedAt ?? "—"}</td>
                    <td className="px-2 py-1">{run.status}</td>
                    <td className="px-2 py-1 tabular-nums">{run.createdCount}</td>
                    <td className="px-2 py-1 tabular-nums">{run.updatedCount}</td>
                    <td className="px-2 py-1 tabular-nums">{run.blockedCount}</td>
                    <td className="px-2 py-1 tabular-nums">{run.failedCount}</td>
                    <td className="px-2 py-1" dir="ltr">{run.actor ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ value, label, tone }: { value: number; label: string; tone: "ink" | "emerald" | "sky" | "amber" | "rose" | "slate" }) {
  const cls: Record<string, string> = {
    ink: "border-slate-200 text-ink",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
    sky: "border-sky-200 bg-sky-50 text-sky-700",
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    rose: "border-rose-200 bg-rose-50 text-rose-700",
    slate: "border-slate-200 bg-slate-50 text-slate-600",
  };
  return <div className={`rounded-lg border p-3 text-center ${cls[tone]}`}><div className="text-xl font-bold">{value}</div><div className="mt-0.5 text-[10px] text-muted">{label}</div></div>;
}
function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-2"><span>{label}</span><span className="font-mono tabular-nums">{value}</span></div>;
}
