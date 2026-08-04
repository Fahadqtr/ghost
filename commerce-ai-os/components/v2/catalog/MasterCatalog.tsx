// Malikas V2 Master Catalog view (Phase UI.1). Read-only presentation: summary
// cards, a GET-form search/filter bar (no client JS, no polling), a clean table
// on desktop and cards on mobile. Renders ONLY catalog-safe fields — never
// stock, channel/platform presence, platform IDs, orders, raw JSON, or PII.

import Link from "next/link";
import {
  CATALOG_FILTER_OPTIONS,
  getCompleteness,
  getCompletenessLabel,
  getDisplayName,
  hasBarcode,
  hasImage,
  hasSku,
  type CatalogFilters,
  type CatalogSummary,
  type MasterCatalogProduct,
} from "@/lib/catalog-v2/master-catalog-view";

function formatPrice(p: MasterCatalogProduct): string {
  const value = p.discountPrice ?? p.price;
  if (value === null) return "—";
  return `${value} ر.ق`;
}

function ImagePlaceholder() {
  return (
    <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-[#efe3d6] bg-[#faf3ec] text-[#d9b48f]">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <circle cx="8.5" cy="9.5" r="1.6" />
        <path d="M21 16l-5-5-8 8" />
      </svg>
    </div>
  );
}

function ProductImage({ product }: { product: MasterCatalogProduct }) {
  if (hasImage(product)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- catalog thumbnails use the stored URL directly; no next/image remote config here.
      <img
        src={product.imageUrl as string}
        alt={getDisplayName(product)}
        loading="lazy"
        className="h-12 w-12 rounded-lg border border-[#efe3d6] object-cover"
      />
    );
  }
  return <ImagePlaceholder />;
}

function CompletenessBadge({ product }: { product: MasterCatalogProduct }) {
  const state = getCompleteness(product);
  const complete = state === "complete";
  return (
    <span
      className={
        "inline-block rounded-full px-2 py-0.5 text-[11px] font-medium " +
        (complete ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700")
      }
    >
      {getCompletenessLabel(state)}
    </span>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="card p-4 text-center">
      <div className="text-2xl font-bold text-ink">{value}</div>
      <div className="mt-1 text-xs text-muted">{label}</div>
    </div>
  );
}

export default function MasterCatalog({
  products,
  allCount,
  summary,
  filters,
  partial,
}: {
  products: MasterCatalogProduct[];
  allCount: number;
  summary: CatalogSummary;
  filters: CatalogFilters;
  partial: boolean;
}) {
  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-serif text-2xl font-semibold text-ink">كتالوج ماليكاس</h1>
          <span className="rounded-full bg-brand-light px-2.5 py-0.5 text-[11px] font-semibold text-brand">
            الكتالوج الرئيسي
          </span>
        </div>
        <p className="text-sm text-muted">المصدر الرئيسي لجميع منتجات ومنصات Malikas Universe</p>
      </div>

      {partial ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          النتائج جزئية — تم عرض جزء من الكتالوج فقط ضمن الحد الآمن للقراءة.
        </div>
      ) : null}

      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <SummaryCard label="إجمالي المنتجات" value={summary.totalProducts} />
        <SummaryCard label="لديها خيارات" value={summary.withVariants} />
        <SummaryCard label="ناقص SKU" value={summary.missingSku} />
        <SummaryCard label="ناقص باركود" value={summary.missingBarcode} />
        <SummaryCard label="ناقص صورة" value={summary.missingImage} />
      </div>

      {/* Search + filters (GET form; no client JS) */}
      <form method="get" className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1">
          <span className="label">بحث</span>
          <input
            type="search"
            name="query"
            defaultValue={filters.query}
            maxLength={80}
            placeholder="SKU أو باركود أو الاسم"
            className="input"
          />
        </label>
        <label className="flex flex-col gap-1 sm:w-56">
          <span className="label">الفلتر</span>
          <select name="filter" defaultValue={filters.filter} className="input">
            {CATALOG_FILTER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2">
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
      ) : products.length === 0 ? (
        <div className="card text-center text-sm text-muted">لا توجد نتائج مطابقة للبحث أو الفلاتر الحالية.</div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="card hidden overflow-x-auto p-0 md:block">
            <table className="w-full text-right text-sm">
              <thead className="border-b border-[#efe3d6] text-xs text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">الصورة</th>
                  <th className="px-4 py-3 font-medium">الاسم</th>
                  <th className="px-4 py-3 font-medium">SKU</th>
                  <th className="px-4 py-3 font-medium">الباركود</th>
                  <th className="px-4 py-3 font-medium">السعر</th>
                  <th className="px-4 py-3 font-medium">الخيارات</th>
                  <th className="px-4 py-3 font-medium">الحالة</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id} className="border-b border-[#f5ece1] last:border-0">
                    <td className="px-4 py-3">
                      <ProductImage product={p} />
                    </td>
                    <td className="px-4 py-3 font-medium text-ink">{getDisplayName(p)}</td>
                    <td className="px-4 py-3 text-muted">{hasSku(p) ? p.sku : "—"}</td>
                    <td className="px-4 py-3 text-muted">{hasBarcode(p) ? p.barcode : "—"}</td>
                    <td className="px-4 py-3 text-ink">{formatPrice(p)}</td>
                    <td className="px-4 py-3 text-muted">{p.variantCount}</td>
                    <td className="px-4 py-3">
                      <CompletenessBadge product={p} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-3 md:hidden">
            {products.map((p) => (
              <div key={p.id} className="card flex gap-3 p-3">
                <ProductImage product={p} />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="truncate font-medium text-ink">{getDisplayName(p)}</div>
                    <CompletenessBadge product={p} />
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted">
                    <span>SKU: {hasSku(p) ? p.sku : "—"}</span>
                    <span>باركود: {hasBarcode(p) ? p.barcode : "—"}</span>
                    <span>الخيارات: {p.variantCount}</span>
                  </div>
                  <div className="text-sm text-ink">{formatPrice(p)}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
