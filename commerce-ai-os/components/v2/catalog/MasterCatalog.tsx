// Malikas V2 Catalog Control Center (Phase UI.2A / UI.3C.1). Read-only Server
// Component: whole-catalog KPI cards, a GET-form search/filter/sort bar (no
// client JS, no polling), and prev/next pagination that preserves the current
// query/filter/sort. The interactive results list (table, cards, preview dialog,
// image lightbox) is delegated to MasterCatalogResults.
//
// Renders ONLY catalog-safe fields — never stock, channel/platform presence,
// platform IDs, orders, raw JSON/approval text, or PII. Rows crossing into the
// client are narrowed by toMasterCatalogPreviewItems(), an explicit whitelist
// that also normalizes the approval text away.

import Link from "next/link";
import {
  CATALOG_FILTER_OPTIONS,
  CATALOG_SORT_OPTIONS,
  catalogHref,
  toMasterCatalogPreviewItems,
  type CatalogControls,
  type CatalogPage,
  type CatalogSummary,
} from "@/lib/catalog-v2/master-catalog-view";
import MasterCatalogResults from "@/components/v2/catalog/MasterCatalogPreview";

function KpiCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="card p-4 text-center">
      <div className="text-2xl font-bold text-ink">{value}</div>
      <div className="mt-1 text-xs text-muted">{label}</div>
    </div>
  );
}

export default function MasterCatalog({
  pageResult,
  allCount,
  matchCount,
  summary,
  controls,
  partial,
}: {
  pageResult: CatalogPage;
  allCount: number;
  matchCount: number;
  summary: CatalogSummary;
  controls: CatalogControls;
  partial: boolean;
}) {
  const { items, page, totalPages, startIndex } = pageResult;
  const firstOnPage = matchCount === 0 ? 0 : startIndex + 1;
  const lastOnPage = startIndex + items.length;
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-serif text-2xl font-semibold text-ink">كتالوج ماليكاس</h1>
            <span className="rounded-full bg-brand-light px-2.5 py-0.5 text-[11px] font-semibold text-brand">
              مركز التحكم بالكتالوج
            </span>
          </div>
          <p className="text-sm text-muted">المصدر الرئيسي لجميع منتجات ومنصات Malikas Universe</p>
        </div>
        {/* Phase UI.5: AI product creator entry */}
        <Link href="/v2/catalog/new" className="btn-primary">
          إضافة منتج بالذكاء الاصطناعي
        </Link>
      </div>

      {partial ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          النتائج جزئية — تم عرض جزء من الكتالوج فقط ضمن الحد الآمن للقراءة.
        </div>
      ) : null}

      {/* KPIs — whole loaded catalog */}
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted">المؤشرات تشمل كامل الكتالوج المحمّل (وليس الصفحة الحالية فقط)</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <KpiCard label="إجمالي المنتجات" value={summary.totalProducts} />
          <KpiCard label="مكتمل" value={summary.complete} />
          <KpiCard label="ناقص أكثر من حقل" value={summary.missingMultiple} />
          <KpiCard label="ناقص SKU" value={summary.missingSku} />
          <KpiCard label="ناقص باركود" value={summary.missingBarcode} />
          <KpiCard label="ناقص صورة" value={summary.missingImage} />
          <KpiCard label="بدون سعر" value={summary.missingPrice} />
          <KpiCard label="عليه خصم" value={summary.withDiscount} />
          <KpiCard label="لديها خيارات" value={summary.withVariants} />
        </div>
      </div>

      {/* Search + filter + sort (GET form; no client JS). No page field → any
          submit resets to page 1. */}
      <form method="get" className="card grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1 lg:col-span-2">
          <span className="label">بحث</span>
          <input
            type="search"
            name="query"
            defaultValue={controls.query}
            maxLength={80}
            placeholder="SKU أو باركود أو الاسم"
            className="input"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">الفلتر</span>
          <select name="filter" defaultValue={controls.filter} className="select-input">
            {CATALOG_FILTER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">الترتيب</span>
          <select name="sort" defaultValue={controls.sort} className="select-input">
            {CATALOG_SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-4">
          <button type="submit" className="btn-primary">
            تطبيق
          </button>
          <Link href="/v2/catalog" className="btn-ghost">
            مسح
          </Link>
        </div>
      </form>

      {/* Results */}
      {allCount === 0 ? (
        <div className="card text-center text-sm text-muted">لا توجد منتجات في كتالوج ماليكاس.</div>
      ) : matchCount === 0 ? (
        <div className="card text-center text-sm text-muted">لا توجد نتائج مطابقة للبحث أو الفلاتر الحالية.</div>
      ) : (
        <>
          {/* Result info */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <span>
              عرض {firstOnPage}–{lastOnPage} من {matchCount} نتيجة
            </span>
            <span>
              صفحة {page} من {totalPages}
            </span>
          </div>

          {/* Results — interactive: a row/card opens the preview dialog. */}
          <MasterCatalogResults items={toMasterCatalogPreviewItems(items, controls)} />

          {/* Pagination — preserves query/filter/sort */}
          {totalPages > 1 ? (
            <div className="flex items-center justify-between gap-2">
              {hasPrev ? (
                <Link href={catalogHref(controls, page - 1)} className="btn-ghost" rel="prev">
                  السابق
                </Link>
              ) : (
                <span className="btn-ghost cursor-default opacity-40" aria-disabled="true">
                  السابق
                </span>
              )}
              <span className="text-xs text-muted">
                صفحة {page} من {totalPages}
              </span>
              {hasNext ? (
                <Link href={catalogHref(controls, page + 1)} className="btn-ghost" rel="next">
                  التالي
                </Link>
              ) : (
                <span className="btn-ghost cursor-default opacity-40" aria-disabled="true">
                  التالي
                </span>
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
