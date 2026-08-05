// Malikas V2 Shopify Catalog view (Phase UI.3C). Read-only presentation of the
// already-matched UI.3B read model: summary cards, a GET-form search/filter/sort
// bar (no client JS, no polling), results as a desktop table and mobile cards,
// prev/next pagination, and a separate collapsed section for unlinked Shopify
// variants.
//
// It renders ONLY catalog-safe fields. It never renders a Shopify GID
// (product/variant/inventory-item id), an inventory quantity, order or customer
// data, a raw error, a token, or a domain — and it holds no matching logic: the
// presence/match states come already decided from the view layer.

import Link from "next/link";
import {
  SHOPIFY_FILTER_OPTIONS,
  SHOPIFY_SORT_OPTIONS,
  getMatchStatusLabel,
  getOrphanReasonLabel,
  getPresenceStatusLabel,
  getRowDisplayName,
  getShopifyStatusLabel,
  shopifyCatalogHref,
  type ShopifyCatalogControls,
  type ShopifyCatalogPage,
  type ShopifyCatalogRow,
  type ShopifyCatalogSummary,
  type ShopifyOrphanVariant,
} from "@/lib/catalog-v2/shopify-catalog-view";

const SHOPIFY_UNAVAILABLE =
  "تعذر تحميل بيانات Shopify حاليًا. تم عرض كتالوج ماليكاس دون تحديد حالة الوجود.";
const PARTIAL_WARNING = "تم تحميل جزء من البيانات فقط.";

function money(value: number): string {
  return `${value} ر.ق`;
}

function hasText(v: string | null): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function ImagePlaceholder() {
  return (
    <div className="flex h-14 w-14 items-center justify-center rounded-lg border border-[#efe3d6] bg-[#faf3ec] text-[#d9b48f]">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <circle cx="8.5" cy="9.5" r="1.6" />
        <path d="M21 16l-5-5-8 8" />
      </svg>
    </div>
  );
}

function RowImage({ row }: { row: ShopifyCatalogRow }) {
  if (hasText(row.imageUrl)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- catalog thumbnails use the stored URL directly; no next/image remote config here.
      <img
        src={row.imageUrl as string}
        alt={getRowDisplayName(row)}
        loading="lazy"
        className="h-14 w-14 rounded-lg border border-[#efe3d6] object-cover"
      />
    );
  }
  return <ImagePlaceholder />;
}

function PresenceBadge({ row }: { row: ShopifyCatalogRow }) {
  const tone =
    row.presenceStatus === "present"
      ? "bg-emerald-50 text-emerald-700"
      : row.presenceStatus === "missing"
        ? "bg-rose-50 text-rose-700"
        : "bg-slate-100 text-slate-600";
  return (
    <span className={"inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium " + tone}>
      {getPresenceStatusLabel(row.presenceStatus)}
    </span>
  );
}

function MatchBadge({ row }: { row: ShopifyCatalogRow }) {
  const tone =
    row.matchStatus === "matched_sku" || row.matchStatus === "matched_barcode"
      ? "bg-emerald-50 text-emerald-700"
      : row.matchStatus === "ambiguous"
        ? "bg-amber-50 text-amber-800"
        : row.matchStatus === "unmatched"
          ? "bg-rose-50 text-rose-700"
          : "bg-slate-100 text-slate-600";
  return (
    <span className={"inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium " + tone}>
      {getMatchStatusLabel(row.matchStatus)}
    </span>
  );
}

function ShopifyStatusBadge({ row }: { row: ShopifyCatalogRow }) {
  const tone =
    row.shopifyStatus === "active"
      ? "bg-emerald-50 text-emerald-700"
      : row.shopifyStatus === "draft"
        ? "bg-sky-50 text-sky-700"
        : row.shopifyStatus === "archived"
          ? "bg-slate-100 text-slate-600"
          : "bg-slate-100 text-slate-500";
  return (
    <span className={"inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium " + tone}>
      {getShopifyStatusLabel(row.shopifyStatus)}
    </span>
  );
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

/** The row detail target — the MASTER product page (no Shopify detail page). */
function rowHref(row: ShopifyCatalogRow): string {
  return `/v2/catalog/${encodeURIComponent(row.masterProductId)}`;
}

function rowKey(row: ShopifyCatalogRow): string {
  return `${row.masterProductId}::${row.masterVariantId ?? ""}`;
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
          <select name="filter" defaultValue={controls.filter} className="input">
            {SHOPIFY_FILTER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 lg:w-40">
          <span className="label">الترتيب</span>
          <select name="sort" defaultValue={controls.sort} className="input">
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

          {/* Desktop table */}
          <div className="card hidden overflow-x-auto p-0 md:block">
            <table className="w-full text-right text-sm">
              <thead className="border-b border-[#efe3d6] text-xs text-muted">
                <tr>
                  <th className="px-3 py-3 font-medium">الصورة</th>
                  <th className="px-3 py-3 font-medium">الاسم</th>
                  <th className="px-3 py-3 font-medium">SKU</th>
                  <th className="px-3 py-3 font-medium">الباركود</th>
                  <th className="px-3 py-3 font-medium">السعر</th>
                  <th className="w-px px-3 py-3 font-medium">حالة الوجود</th>
                  <th className="w-px px-3 py-3 font-medium">طريقة المطابقة</th>
                  <th className="w-px px-3 py-3 font-medium">حالة Shopify</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={rowKey(row)} className="border-b border-[#f5ece1] last:border-0 hover:bg-[#fffaf4]">
                    <td className="px-3 py-2.5">
                      <Link href={rowHref(row)} aria-label={getRowDisplayName(row)}>
                        <RowImage row={row} />
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 font-medium">
                      <Link href={rowHref(row)} className="text-ink hover:text-brand hover:underline">
                        {getRowDisplayName(row)}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-muted">{hasText(row.sku) ? row.sku : "—"}</td>
                    <td className="px-3 py-2.5 text-muted">{hasText(row.barcode) ? row.barcode : "—"}</td>
                    <td className="px-3 py-2.5">
                      {typeof row.price === "number" ? (
                        <span className="text-ink">{money(row.price)}</span>
                      ) : (
                        <span className="text-rose-600">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <PresenceBadge row={row} />
                    </td>
                    <td className="px-3 py-2.5">
                      <MatchBadge row={row} />
                    </td>
                    <td className="px-3 py-2.5">
                      <ShopifyStatusBadge row={row} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-2.5 md:hidden">
            {items.map((row) => (
              <Link key={rowKey(row)} href={rowHref(row)} className="card flex gap-3 p-3">
                <RowImage row={row} />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="truncate font-medium text-ink">{getRowDisplayName(row)}</div>
                  <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted">
                    <span>SKU: {hasText(row.sku) ? row.sku : "—"}</span>
                    <span>باركود: {hasText(row.barcode) ? row.barcode : "—"}</span>
                    <span>السعر: {typeof row.price === "number" ? money(row.price) : "—"}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <PresenceBadge row={row} />
                    <MatchBadge row={row} />
                    <ShopifyStatusBadge row={row} />
                  </div>
                </div>
              </Link>
            ))}
          </div>

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
