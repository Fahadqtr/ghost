// Malikas V2 Shopify Catalog view (Phase UI.3C / UI.3C.1). Read-only Server
// Component: summary cards, a GET-form search/filter/sort bar (no client JS, no
// polling), prev/next pagination, and a separate collapsed section for unlinked
// Shopify variants. The interactive results list (table, cards, preview dialog,
// image lightbox) is delegated to ShopifyCatalogResults.
//
// It renders ONLY catalog-safe fields. It never renders a Shopify GID
// (product/variant/inventory-item id), an inventory quantity, order or customer
// data, a raw error, a token, or a domain — and it holds no matching logic: the
// presence/match states come already decided from the view layer. Rows crossing
// into the client are narrowed by toPreviewItems(), which drops every Shopify
// identifier so none is serialized into the HTML payload.

import Link from "next/link";
import {
  SHOPIFY_FILTER_OPTIONS,
  SHOPIFY_SORT_OPTIONS,
  getOrphanReasonLabel,
  getShopifyStatusLabel,
  shopifyCatalogHref,
  toPreviewItems,
  type ShopifyCatalogControls,
  type ShopifyCatalogPage,
  type ShopifyCatalogSummary,
  type ShopifyOrphanVariant,
} from "@/lib/catalog-v2/shopify-catalog-view";
import ShopifyCatalogResults from "@/components/v2/catalog/ShopifyProductPreview";

const SHOPIFY_UNAVAILABLE =
  "تعذر تحميل بيانات Shopify حاليًا. تم عرض كتالوج ماليكاس دون تحديد حالة الوجود.";
const PARTIAL_WARNING = "تم تحميل جزء من البيانات فقط.";

function hasText(v: string | null): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/** A summary card. `value === null` means "unknown" and renders a dash — never 0. */
function SummaryCard({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="card px-3 py-2.5 text-center">
      <div className="text-xl font-bold text-ink">{value === null ? "—" : value}</div>
      <div className="mt-0.5 text-[11px] leading-tight text-muted">{label}</div>
    </div>
  );
}

export default function ShopifyCatalog({
  pageResult,
  allCount,
  matchCount,
  summary,
  controls,
  orphanVariants,
  partial,
  shopifyAvailable,
}: {
  pageResult: ShopifyCatalogPage;
  allCount: number;
  matchCount: number;
  summary: ShopifyCatalogSummary;
  controls: ShopifyCatalogControls;
  orphanVariants: ShopifyOrphanVariant[];
  partial: boolean;
  shopifyAvailable: boolean;
}) {
  const { items, page, totalPages, startIndex } = pageResult;
  const firstOnPage = matchCount === 0 ? 0 : startIndex + 1;
  const lastOnPage = startIndex + items.length;
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-serif text-2xl font-semibold text-ink">كتالوج Shopify</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-semibold text-slate-600">
            قراءة فقط
          </span>
        </div>
        <p className="text-sm text-muted">مقارنة منتجات ماليكاس مع منتجات Shopify</p>
      </div>

      {!shopifyAvailable ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">{SHOPIFY_UNAVAILABLE}</div>
      ) : null}

      {partial ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">{PARTIAL_WARNING}</div>
      ) : null}

      {/* Summary — whole loaded set, not just this page */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        <SummaryCard label="إجمالي العناصر القابلة للبيع" value={summary.total} />
        <SummaryCard label="موجودة في Shopify" value={summary.present} />
        <SummaryCard label="غير موجودة في Shopify" value={summary.missing} />
        <SummaryCard label="غير مطابقة" value={summary.unmatched} />
        <SummaryCard label="تتطلب مراجعة" value={summary.ambiguous} />
      </div>

      {/* Search + filter + sort — one row on desktop. No page field, so any
          submit resets to page 1. */}
      <form method="get" className="card flex flex-col gap-2.5 p-3 lg:flex-row lg:items-end lg:gap-3">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
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
        <label className="flex flex-col gap-1 lg:w-48">
          <span className="label">الحالة</span>
          <select name="filter" defaultValue={controls.filter} className="select-input">
            {SHOPIFY_FILTER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 lg:w-40">
          <span className="label">الترتيب</span>
          <select name="sort" defaultValue={controls.sort} className="select-input">
            {SHOPIFY_SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex shrink-0 items-center gap-2">
          <button type="submit" className="btn-primary">
            تطبيق
          </button>
          <Link href="/v2/catalog/shopify" className="btn-ghost">
            مسح
          </Link>
        </div>
      </form>

      {/* Results */}
      {allCount === 0 ? (
        <div className="card text-center text-sm text-muted">لا توجد عناصر قابلة للبيع في كتالوج ماليكاس.</div>
      ) : matchCount === 0 ? (
        <div className="card text-center text-sm text-muted">لا توجد نتائج مطابقة للبحث أو الفلاتر الحالية.</div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <span>
              عرض {firstOnPage}–{lastOnPage} من {matchCount} نتيجة
            </span>
            <span>
              صفحة {page} من {totalPages}
            </span>
          </div>

          {/* Results — interactive: a row/card opens the preview dialog. */}
          <ShopifyCatalogResults items={toPreviewItems(items)} />

          {/* Pagination — preserves query/filter/sort */}
          {totalPages > 1 ? (
            <div className="flex items-center justify-between gap-2">
              {hasPrev ? (
                <Link href={shopifyCatalogHref(controls, page - 1)} className="btn-ghost" rel="prev">
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
                <Link href={shopifyCatalogHref(controls, page + 1)} className="btn-ghost" rel="next">
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

      {/* Unlinked Shopify variants — a SEPARATE section, collapsed by default.
          Hidden entirely when Shopify was unavailable (there is nothing proven
          to report). Renders no GID. */}
      {shopifyAvailable && orphanVariants.length > 0 ? (
        <details className="card p-0">
          <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-ink">
            متغيرات Shopify غير المرتبطة
            <span className="mr-2 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
              {orphanVariants.length}
            </span>
          </summary>
          <div className="overflow-x-auto border-t border-[#efe3d6]">
            <table className="w-full text-right text-sm">
              <thead className="border-b border-[#efe3d6] text-xs text-muted">
                <tr>
                  <th className="px-3 py-2.5 font-medium">الاسم</th>
                  <th className="px-3 py-2.5 font-medium">SKU</th>
                  <th className="px-3 py-2.5 font-medium">الباركود</th>
                  <th className="px-3 py-2.5 font-medium">حالة Shopify</th>
                  <th className="px-3 py-2.5 font-medium">السبب</th>
                </tr>
              </thead>
              <tbody>
                {orphanVariants.map((o, i) => (
                  <tr key={`orphan-${i}`} className="border-b border-[#f5ece1] last:border-0">
                    <td className="px-3 py-2.5 text-ink">{hasText(o.title) ? o.title : "—"}</td>
                    <td className="px-3 py-2.5 text-muted">{hasText(o.sku) ? o.sku : "—"}</td>
                    <td className="px-3 py-2.5 text-muted">{hasText(o.barcode) ? o.barcode : "—"}</td>
                    <td className="px-3 py-2.5">
                      <span className="inline-block whitespace-nowrap rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                        {getShopifyStatusLabel(o.status)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-muted">{getOrphanReasonLabel(o.reason)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </div>
  );
}
