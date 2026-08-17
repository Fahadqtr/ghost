"use client";

// INT.2E — Shopify validation + publish preview surface (presentational + client
// filter state only). READ-ONLY: it renders the certified preview and holds NO
// I/O, NO mutation, NO identity re-derivation, and NO publish/generate action. It
// shows the dashboard counts (Total / Matched / New / Updates / Conflicts /
// Blocked / Unknown), the deterministic future mutation-plan tally (§12), the
// honest read cost (§14), a filterable/searchable table with per-row field &
// variant change chips, and — when Shopify is unreadable — a clear "unknown"
// banner instead of any invented diff.

import { useMemo, useState } from "react";
import type { ExportReasonCode } from "@/lib/export/validation";
import type { ShopifyPreviewStatus, ShopifyPlanOpType } from "@/lib/export/shopify/preview";
import { paginate, DEFAULT_PAGE_SIZE } from "@/lib/ui/pagination";
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
}

export interface ShopifyPreviewVM {
  shopifyAvailable: boolean;
  productsRead: number; // §14 — live Shopify products read in the single batch
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

export default function ShopifyPreview({ vm }: { vm: ShopifyPreviewVM }) {
  const [filter, setFilter] = useState<RowFilter>("ALL");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

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
  const chip = (active: boolean) => `rounded-full border px-3 py-1 text-xs transition-colors ${active ? "border-brand bg-brand-light text-brand" : "border-slate-200 bg-white text-muted hover:bg-slate-50"}`;
  const opEntries = (Object.entries(vm.counts.plannedOps) as [ShopifyPlanOpType, number][]).filter(([, n]) => n > 0);

  return (
    <div className="space-y-4">
      <p className="text-[11px] text-muted">
        معاينة للقراءة فقط — لا يتم إنشاء أو تعديل أي منتج في شوبي فاي. الهوية تُقرأ من ECL
        (<span dir="ltr">shopify:malikas</span>) عبر مُعرّف المنتج/المتغيّر فقط — لا تخمين ولا مطابقة بالاسم.
        الفروقات تُعرض فقط عندما يمكن إثباتها من بيانات موثوقة.
      </p>

      {!vm.shopifyAvailable && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          شوبي فاي غير مهيأ أو تعذّرت قراءته الآن — كل الصفوف «غير معروفة» ولا تُعرض أي فروقات ملفّقة.
        </div>
      )}

      {/* Dashboard counts (§11) */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        <Card value={vm.counts.total} label="إجمالي" tone="ink" />
        <Card value={vm.counts.matched} label="مطابق" tone="emerald" />
        <Card value={vm.counts.new} label="جديد" tone="sky" />
        <Card value={vm.counts.updateRequired} label="تحديثات" tone="amber" />
        <Card value={vm.counts.conflict} label="تعارضات" tone="rose" />
        <Card value={vm.counts.blocked} label="محظور" tone="rose" />
        <Card value={vm.counts.unknown} label="غير معروف" tone="slate" />
      </div>

      {/* Future mutation plan (§12) + read cost (§14) */}
      <div className="card space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-semibold text-ink">خطة التغيير المستقبلية (معاينة فقط)</div>
          <span className="text-[11px] text-muted">قراءة شوبي فاي: {vm.productsRead} منتج · دفعة واحدة</span>
        </div>
        {opEntries.length === 0 ? (
          <p className="text-[11px] text-muted">لا توجد عمليات مخطّطة بعد.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {opEntries.map(([op, n]) => (
              <span key={op} className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-ink">{OP_LABEL[op]} · {n}</span>
            ))}
          </div>
        )}
        <p className="text-[11px] text-muted">
          هذه خطة للاطّلاع فقط — لا يوجد أي تنفيذ في هذه المرحلة (INT.2E). لا نشر تلقائي ولا كتابة مخزون.
        </p>
      </div>

      {/* Filters (§11) */}
      <div className="card flex flex-wrap items-center gap-2">
        {(["ALL", "MATCH", "NEW", "UPDATE_REQUIRED", "CONFLICT", "BLOCKED", "UNKNOWN"] as RowFilter[]).map((f) => (
          <button key={f} type="button" onClick={() => { setFilter(f); setPage(1); }} className={chip(filter === f)}>
            {f === "ALL" ? "الكل" : STATUS_LABEL[f as ShopifyPreviewStatus]}
          </button>
        ))}
        <input type="search" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="بحث SKU / اسم / GID…" className="min-w-[12rem] flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs text-ink" />
        <span className="text-[11px] text-muted">يعرض {pageView.pageItems.length} من {filtered.length}</span>
      </div>

      {/* Table (§11) */}
      {filtered.length === 0 ? (
        <EmptyState title="لا توجد صفوف مطابقة" message="لا توجد منتجات مطابقة للفلاتر الحالية. جرّب تغيير الفلتر أو مسح البحث." />
      ) : (
        <>
          <div className="card overflow-x-auto p-0">
            <table className="w-full min-w-[920px] text-right text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-[11px] text-muted">
                <tr>
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
                  const accent = r.status === "CONFLICT" || r.status === "BLOCKED" ? "border-s-4 border-s-rose-400"
                    : r.status === "UPDATE_REQUIRED" ? "border-s-4 border-s-amber-400"
                    : r.status === "NEW" ? "border-s-4 border-s-sky-400"
                    : r.status === "MATCH" ? "border-s-4 border-s-emerald-400"
                    : "border-s-4 border-s-slate-300";
                  return (
                    <tr key={r.id} className={`border-b border-slate-100 last:border-0 ${accent}`}>
                      <td className="px-3 py-2 font-mono text-[11px]" dir="ltr">{r.sku || (r.hasVariants ? <span className="text-muted">متغيّرات</span> : <span className="text-rose-600">—</span>)}</td>
                      <td className="px-3 py-2 text-ink">{r.title || <span className="text-rose-600">بدون عنوان</span>}</td>
                      <td className="px-3 py-2 font-mono text-[10px]" dir="ltr">
                        {r.shopifyProductGid
                          ? <span title={r.shopifyProductGid}>…{r.shopifyProductGid.slice(-10)}</span>
                          : r.status === "NEW" ? <span className="text-sky-600">جديد</span> : <span className="text-muted">—</span>}
                      </td>
                      <td className="px-3 py-2 tabular-nums" dir="ltr">
                        {r.variantMatchedCount}/{r.variantCount}
                      </td>
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
