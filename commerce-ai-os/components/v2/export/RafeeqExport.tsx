"use client";

// INT.2D — Rafeeq export PREVIEW surface (presentational + client state).
//
// Renders the certified Rafeeq preview (product grain): the export plan +
// grouped blocked reasons and the full row table with filters/search. This
// surface is REVIEW-ONLY — the owner-approved rule is that the Rafeeq page
// exposes exactly TWO generation actions, both on the FullSync card
// ("توليد كتالوج رفيق الكامل" and "تحميل ملف المنتجات الجديدة"), so no generate
// button exists here and no UI action can reach the retired buffered route.
// It holds only view state — no I/O, no mutation, no identity re-derivation,
// no conflict resolution. needs_review rows are BLOCKED and clearly labelled.

import { useMemo, useState } from "react";
import type { ExportItemStatus, ExportReasonCode } from "@/lib/export/validation";
import { paginate, DEFAULT_PAGE_SIZE } from "@/lib/ui/pagination";
import EmptyState from "@/components/v2/ui/EmptyState";

export interface RafeeqRowVM {
  /** stable product row key (product-grain — one row per canonical product). */
  id: string;
  sku: string;
  barcode: string | null;
  title: string;
  price: number | null;
  /** differing option prices ⇒ the product_price cell is "PRICE ON SELECTION". */
  priceOnSelection: boolean;
  /** native options of this ONE product (0 = simple). */
  optionCount: number;
  rafeeqId: string | null;
  needsOwnerReview: boolean;
  hasImage: boolean;
  imageExportName: string | null;
  imageCount: number;
  status: ExportItemStatus;
  reasons: { code: ExportReasonCode; blocking: boolean }[];
}

export interface RafeeqExportVM {
  canWrite: boolean;
  rows: RafeeqRowVM[];
  counts: {
    /** canonical Rafeeq PRODUCT identities — the business count. */
    productCount: number;
    productsWithOptions: number;
    optionCount: number;
    /** physical spreadsheet rows (a parent repeats once per option). */
    physicalRowCount: number;
    mappedCount: number;
    unmappedCount: number;
    needsReviewCount: number;
    /** differing-price parents encoded as PRICE ON SELECTION + full prices. */
    priceOnSelectionCount: number;
  };
}

type RowFilter = "ALL" | ExportItemStatus | "NEW" | "MAPPED" | "NEEDS_REVIEW";

const REASON_LABEL: Record<string, string> = {
  MISSING_SKU: "SKU مفقود", DUPLICATE_SKU: "SKU مكرّر", MISSING_BARCODE: "باركود مفقود",
  DUPLICATE_BARCODE: "باركود مكرّر", INVALID_BARCODE: "صيغة باركود غير قياسية", MISSING_IMAGE: "صورة مفقودة",
  MISSING_TITLE: "عنوان مفقود", MISSING_PRICE: "سعر مفقود", MISSING_CATEGORY: "فئة مفقودة",
  LIFECYCLE_NOT_ELIGIBLE: "غير مؤهّل (دورة الحياة)", IDENTITY_MISSING: "هوية مفقودة",
  IDENTITY_CONFLICT: "تعارض هوية", IDENTITY_NEEDS_REVIEW: "بحاجة لمراجعة المالك",
  VARIANT_NOT_READY: "خيار غير جاهز",
  UNSUPPORTED: "غير مدعوم",
};
const STATUS_LABEL: Record<ExportItemStatus, string> = { READY: "جاهز", WARNING: "تحذير", BLOCKED: "محظور", UNKNOWN: "غير معروف" };

export default function RafeeqExport({ vm }: { vm: RafeeqExportVM }) {
  const [filter, setFilter] = useState<RowFilter>("ALL");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  const plan = useMemo(() => {
    let ready = 0, warn = 0, blocked = 0, unknown = 0, mapped = 0, unmapped = 0, needsReview = 0, included = 0, images = 0;
    const blockers: Partial<Record<ExportReasonCode, number>> = {};
    for (const r of vm.rows) {
      if (r.status === "READY") ready++; else if (r.status === "WARNING") warn++; else if (r.status === "BLOCKED") blocked++; else unknown++;
      if (r.rafeeqId !== null) mapped++; else unmapped++;
      if (r.needsOwnerReview) needsReview++;
      if (r.status === "BLOCKED") { for (const x of r.reasons) if (x.blocking) blockers[x.code] = (blockers[x.code] ?? 0) + 1; continue; }
      // PRIMARY ONLY (owner contract): Rafeeq packages exactly one image per product.
      included++; images += r.hasImage ? 1 : 0;
    }
    return { ready, warn, blocked, unknown, mapped, unmapped, needsReview, included, images, blockers };
  }, [vm.rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return vm.rows.filter((r) => {
      if (filter === "NEW" && r.rafeeqId !== null) return false;
      if (filter === "MAPPED" && r.rafeeqId === null) return false;
      if (filter === "NEEDS_REVIEW" && !r.needsOwnerReview) return false;
      if ((filter === "READY" || filter === "WARNING" || filter === "BLOCKED" || filter === "UNKNOWN") && r.status !== filter) return false;
      if (needle) {
        const hay = `${r.sku} ${r.title} ${r.barcode ?? ""} ${r.rafeeqId ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [vm.rows, filter, q]);

  const pageView = useMemo(() => paginate(filtered, page, DEFAULT_PAGE_SIZE), [filtered, page]);

  const chip = (active: boolean) => `rounded-full border px-3 py-1 text-xs transition-colors ${active ? "border-brand bg-brand-light text-brand" : "border-slate-200 bg-white text-muted hover:bg-slate-50"}`;
  const blockerEntries = Object.entries(plan.blockers).filter(([, n]) => (n ?? 0) > 0);

  return (
    <div className="space-y-4">
      <p className="text-[11px] text-muted">
        النموذج الأصلي لرفيق (القالب الحقيقي المدقَّق): منتج واحد = هوية منتج واحدة في رفيق.
        المتغيّرات = «خيارات» داخل مجموعة خيارات واحدة للمنتج الأب — لا تُصدَّر كمنتجات مستقلة.
        الملف يكرّر صفّ الأب مرة لكل خيار (نفس الاسم والسعر والصورة) وتتغيّر خلايا الخيار فقط.
        عمود باركود رفيق يحمل <span dir="ltr">SKU</span> المنتج الأب — لا يُصدَّر الباركود الحقيقي
        (<span dir="ltr">EAN</span>) ولا <span dir="ltr">SKU</span>/باركود الخيار إلى رفيق أبداً.
        مُعرّف رفيق مقروء من ECL
        (<span dir="ltr">rafeeq:malikas</span>) فقط — لا يُخمَّن، ولا يُطابَق بالاسم، ولا تُحلّ التعارضات تلقائياً.
        صفوف «بحاجة لمراجعة المالك» محظورة.
      </p>

      {/* Summary — canonical PRODUCT identities are the business count; the
          physical spreadsheet rows are shown separately. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
        <Card value={vm.counts.productCount} label="منتجات رفيق (هويات)" tone="ink" />
        <Card value={vm.counts.productsWithOptions} label="منتجات بخيارات" tone="ink" />
        <Card value={vm.counts.optionCount} label="خيارات" tone="ink" />
        <Card value={vm.counts.physicalRowCount} label="صفوف الملف الفعلية" tone="ink" />
        <Card value={plan.ready} label="جاهز" tone="emerald" />
        <Card value={plan.blocked} label="محظور" tone="rose" />
      </div>

      {/* Export plan — READ-ONLY overview. Generation lives on the FullSync
          card (exactly two actions: full catalog + new-products file). */}
      <div className="card space-y-2">
        <div className="text-sm font-semibold text-ink">خطة التصدير (معاينة فقط)</div>
        <div className="grid grid-cols-2 gap-2 text-[11px] text-muted sm:grid-cols-4">
          <Stat label="سيُضمَّن" value={plan.included} />
          <Stat label="صور متوقّعة" value={plan.images} />
          <Stat label="مربوط" value={plan.mapped} />
          <Stat label="جديد (غير مربوط)" value={plan.unmapped} />
        </div>
        {blockerEntries.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {blockerEntries.map(([code, n]) => (
              <span key={code} className="rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] text-rose-700">{REASON_LABEL[code] ?? code} · {n}</span>
            ))}
          </div>
        )}
        <p className="text-[11px] text-muted">
          توليد الملفات يتم من بطاقة «مزامنة ملفات رفيق» أدناه:
          «توليد كتالوج رفيق الكامل» أو «تحميل ملف المنتجات الجديدة».
        </p>
      </div>

      {/* Filters */}
      <div className="card flex flex-wrap items-center gap-2">
        {(["ALL", "READY", "WARNING", "BLOCKED", "NEW", "MAPPED", "NEEDS_REVIEW"] as RowFilter[]).map((f) => (
          <button key={f} type="button" onClick={() => { setFilter(f); setPage(1); }} className={chip(filter === f)}>
            {f === "ALL" ? "الكل" : f === "NEW" ? "جديد" : f === "MAPPED" ? "مربوط" : f === "NEEDS_REVIEW" ? "بحاجة لمراجعة" : STATUS_LABEL[f as ExportItemStatus]}
          </button>
        ))}
        <input type="search" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="بحث SKU / اسم / مُعرّف رفيق…" className="min-w-[12rem] flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs text-ink" />
        <span className="text-[11px] text-muted">يعرض {pageView.pageItems.length} من {filtered.length}</span>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <EmptyState title="لا توجد صفوف مطابقة" message="لا توجد منتجات مطابقة للفلاتر الحالية. جرّب تغيير الفلتر أو مسح البحث." />
      ) : (
        <>
          <div className="card overflow-x-auto p-0">
            <table className="w-full min-w-[860px] text-right text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-[11px] text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">SKU</th>
                  <th className="px-3 py-2 font-medium">المنتج</th>
                  <th className="px-3 py-2 font-medium">الخيارات</th>
                  <th className="px-3 py-2 font-medium">باركود رفيق (SKU الأب)</th>
                  <th className="px-3 py-2 font-medium">السعر</th>
                  <th className="px-3 py-2 font-medium">مُعرّف رفيق / جديد</th>
                  <th className="px-3 py-2 font-medium">الصورة</th>
                  <th className="px-3 py-2 font-medium">الحالة</th>
                  <th className="px-3 py-2 font-medium">السبب</th>
                </tr>
              </thead>
              <tbody>
                {pageView.pageItems.map((r) => {
                  const accent = r.status === "BLOCKED" ? "border-s-4 border-s-rose-400"
                    : r.status === "WARNING" ? "border-s-4 border-s-amber-400"
                    : "border-s-4 border-s-emerald-400";
                  return (
                    <tr key={r.id} className={`border-b border-slate-100 last:border-0 ${accent}`}>
                      <td className="px-3 py-2 font-mono text-[11px]" dir="ltr">{r.sku || <span className="text-rose-600">—</span>}</td>
                      <td className="px-3 py-2 text-ink">{r.title || <span className="text-rose-600">بدون عنوان</span>}</td>
                      <td className="px-3 py-2 tabular-nums">{r.optionCount > 0 ? r.optionCount : "—"}</td>
                      <td className="px-3 py-2 font-mono text-[11px]" dir="ltr">{r.barcode ?? "—"}</td>
                      <td className="px-3 py-2" dir="ltr">{r.priceOnSelection ? <span className="text-[10px] font-mono">PRICE ON SELECTION</span> : r.price ?? <span className="text-amber-600">—</span>}</td>
                      <td className="px-3 py-2 font-mono text-[11px]" dir="ltr">
                        {r.needsOwnerReview ? <span className="text-rose-600">تعارض — مراجعة</span> : r.rafeeqId ?? <span className="text-amber-600">جديد</span>}
                      </td>
                      <td className="px-3 py-2 font-mono text-[10px] text-muted" dir="ltr">{r.hasImage ? (r.imageExportName ?? "—") : <span className="text-rose-600">مفقودة</span>}</td>
                      <td className="px-3 py-2"><span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] ${r.status === "READY" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : r.status === "WARNING" ? "border-amber-200 bg-amber-50 text-amber-700" : r.status === "BLOCKED" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-slate-200 bg-slate-50 text-slate-600"}`}>{STATUS_LABEL[r.status]}</span></td>
                      <td className="px-3 py-2">{r.reasons.length === 0 ? <span className="text-emerald-600">—</span> : (
                        <div className="flex flex-wrap gap-1">{r.reasons.map((x, i) => <span key={`${x.code}:${i}`} className={`rounded px-1.5 py-0.5 text-[10px] ${x.blocking ? "bg-rose-50 text-rose-600" : "bg-amber-50 text-amber-700"}`}>{REASON_LABEL[x.code] ?? x.code}</span>)}</div>
                      )}</td>
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

function Card({ value, label, tone }: { value: number; label: string; tone: "ink" | "emerald" | "amber" | "rose" }) {
  const cls: Record<string, string> = { ink: "border-slate-200 text-ink", emerald: "border-emerald-200 bg-emerald-50 text-emerald-700", amber: "border-amber-200 bg-amber-50 text-amber-700", rose: "border-rose-200 bg-rose-50 text-rose-700" };
  return <div className={`rounded-lg border p-3 text-center ${cls[tone]}`}><div className="text-xl font-bold">{value}</div><div className="mt-0.5 text-[10px] text-muted">{label}</div></div>;
}
function Stat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-lg border border-slate-200 px-2 py-1.5 text-center"><div className="text-sm font-semibold text-ink">{value}</div><div className="text-[10px] text-muted">{label}</div></div>;
}
