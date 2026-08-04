// Malikas V2 read-only Product Detail (Phase UI.2B). Renders one product's
// catalog-safe fields and its variants. RTL, responsive (desktop table + mobile
// cards). Never renders stock, channel/platform presence, platform IDs, orders,
// raw JSON/approval text, or PII. No editing/selection/actions.

import Link from "next/link";
import {
  getApprovalLabel,
  getCompleteness,
  getCompletenessLabel,
  getDisplayName,
  getVariantDisplayName,
  hasBarcode,
  hasImage,
  hasSku,
  hasValidDiscount,
  hasValidPrice,
  isApproved,
  type CatalogVariant,
  type MasterCatalogProduct,
} from "@/lib/catalog-v2/master-catalog-view";

function money(value: number): string {
  return `${value} ر.ق`;
}

function ImagePlaceholder({ size }: { size: "sm" | "lg" }) {
  const box = size === "lg" ? "h-28 w-28" : "h-10 w-10";
  return (
    <div className={`flex ${box} items-center justify-center rounded-lg border border-[#efe3d6] bg-[#faf3ec] text-[#d9b48f]`}>
      <svg viewBox="0 0 24 24" width={size === "lg" ? "40" : "18"} height={size === "lg" ? "40" : "18"} fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
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
      // eslint-disable-next-line @next/next/no-img-element -- catalog images use the stored URL directly; no next/image remote config here.
      <img
        src={product.imageUrl as string}
        alt={getDisplayName(product)}
        loading="lazy"
        className="h-28 w-28 rounded-lg border border-[#efe3d6] object-cover"
      />
    );
  }
  return <ImagePlaceholder size="lg" />;
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

function ApprovalBadge({ product }: { product: MasterCatalogProduct }) {
  const ok = isApproved(product);
  return (
    <span
      className={
        "inline-block rounded-full px-2 py-0.5 text-[11px] font-medium " +
        (ok ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700")
      }
    >
      {getApprovalLabel(product)}
    </span>
  );
}

function ProductPrice({ product }: { product: MasterCatalogProduct }) {
  if (hasValidDiscount(product)) {
    return (
      <span className="inline-flex flex-wrap items-baseline gap-2">
        <span className="text-sm text-muted line-through">{money(product.price as number)}</span>
        <span className="text-lg font-semibold text-emerald-700">{money(product.discountPrice as number)}</span>
      </span>
    );
  }
  if (hasValidPrice(product)) {
    return <span className="text-lg font-semibold text-ink">{money(product.price as number)}</span>;
  }
  return <span className="text-rose-600">—</span>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-sm text-ink">{value}</span>
    </div>
  );
}

function variantPrice(v: CatalogVariant): string {
  return typeof v.price === "number" && Number.isFinite(v.price) && v.price > 0 ? money(v.price) : "—";
}

export default function ProductDetail({
  product,
  variants,
  backHref = "/v2/catalog",
}: {
  product: MasterCatalogProduct;
  variants: CatalogVariant[];
  backHref?: string;
}) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={backHref} className="btn-ghost">
          رجوع للكتالوج
        </Link>
        <span className="rounded-full bg-brand-light px-2.5 py-0.5 text-[11px] font-semibold text-brand">
          تفاصيل المنتج
        </span>
      </div>

      {/* Product header */}
      <div className="card flex flex-col gap-4 p-5 sm:flex-row">
        <ProductImage product={product} />
        <div className="min-w-0 flex-1 space-y-3">
          <div className="space-y-1">
            <h1 className="font-serif text-2xl font-semibold text-ink">{getDisplayName(product)}</h1>
            {product.nameEn ? <div className="text-sm text-muted" dir="ltr">{product.nameEn}</div> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <CompletenessBadge product={product} />
            <ApprovalBadge product={product} />
          </div>
          <div><ProductPrice product={product} /></div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Fact label="SKU" value={hasSku(product) ? (product.sku as string) : "—"} />
            <Fact label="الباركود" value={hasBarcode(product) ? (product.barcode as string) : "—"} />
            <Fact label="عدد الخيارات" value={`${product.variantCount}`} />
          </div>
        </div>
      </div>

      {/* Variants */}
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-ink">الخيارات ({variants.length})</h2>
        {variants.length === 0 ? (
          <div className="card text-center text-sm text-muted">لا توجد خيارات لهذا المنتج.</div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="card hidden overflow-x-auto p-0 md:block">
              <table className="w-full text-right text-sm">
                <thead className="border-b border-[#efe3d6] text-xs text-muted">
                  <tr>
                    <th className="px-4 py-3 font-medium">الاسم</th>
                    <th className="px-4 py-3 font-medium">SKU</th>
                    <th className="px-4 py-3 font-medium">الباركود</th>
                    <th className="px-4 py-3 font-medium">السعر</th>
                  </tr>
                </thead>
                <tbody>
                  {variants.map((v, i) => (
                    <tr key={v.id ?? `v-${i}`} className="border-b border-[#f5ece1] last:border-0">
                      <td className="px-4 py-3 font-medium text-ink">{getVariantDisplayName(v)}</td>
                      <td className="px-4 py-3 text-muted">{v.sku ?? "—"}</td>
                      <td className="px-4 py-3 text-muted">{v.barcode ?? "—"}</td>
                      <td className="px-4 py-3 text-ink">{variantPrice(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="space-y-3 md:hidden">
              {variants.map((v, i) => (
                <div key={v.id ?? `v-${i}`} className="card space-y-1 p-3">
                  <div className="font-medium text-ink">{getVariantDisplayName(v)}</div>
                  <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted">
                    <span>SKU: {v.sku ?? "—"}</span>
                    <span>باركود: {v.barcode ?? "—"}</span>
                    <span>السعر: {variantPrice(v)}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
