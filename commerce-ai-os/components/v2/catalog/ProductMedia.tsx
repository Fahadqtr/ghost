// Malikas V2 — Product media viewer (UX.4C-1 read → 4C-2 controls slot →
// 4C-3 per-item actions).
//
// A shared, presentational component that renders a product's photos from a
// pre-computed ProductMediaState. It holds NO state and does NO data access —
// the caller reads the media and passes the state in.
//
// Two layouts, chosen by whether `renderItemActions` is supplied:
//   • READ-ONLY (detail page): a primary hero + small extra thumbnails, no
//     controls. This is the default (no `renderItemActions`).
//   • EDIT (edit form): a uniform grid where every image carries a primary badge
//     (when primary) and a per-item actions row supplied by the caller
//     (set-primary / delete / reorder). The global upload/replace control still
//     comes through the `children` footer slot.
// It stays presentational (JSX over props, no client directive, no data access),
// so it renders in BOTH the server detail page and the client edit form. RTL,
// mobile-first.

import type { ReactNode } from "react";
import type { ProductMediaItem, ProductMediaState } from "@/lib/products/product-media";

export default function ProductMedia({
  state,
  children,
  renderItemActions,
}: {
  state: ProductMediaState;
  /** Optional controls footer (edit mode). Read-only callers omit it. */
  children?: ReactNode;
  /** Optional per-image actions (edit mode). When present, the grid layout is
   *  used and this is rendered under each image. Read-only callers omit it. */
  renderItemActions?: (item: ProductMediaItem, index: number) => ReactNode;
}) {
  const { primary, images } = state;
  const extras = images.slice(1); // images[0] is always the primary when present
  const editMode = typeof renderItemActions === "function";

  return (
    <section dir="rtl" className="card space-y-3">
      <h2 className="text-sm font-semibold text-ink">صور المنتج</h2>

      {images.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[#efe3d6] bg-[#faf6f1] px-3 py-6 text-center text-sm text-muted">
          لا توجد صور لهذا المنتج
        </p>
      ) : editMode ? (
        // ── Edit grid: every image uniform, with a badge + per-item actions ──
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {images.map((item, i) => (
            <div key={item.id ?? item.url} className="space-y-1.5">
              <div className="relative aspect-square overflow-hidden rounded-xl border border-[#efe3d6] bg-[#faf6f1]">
                {/* eslint-disable-next-line @next/next/no-img-element -- Supabase Storage public URL */}
                <img src={item.url} alt={item.isPrimary ? "الصورة الرئيسية" : `صورة ${i + 1}`} loading="lazy" className="block h-full w-full object-cover" />
                {item.isPrimary ? (
                  <span className="absolute right-1.5 top-1.5 rounded-full bg-brand px-2 py-0.5 text-[10px] font-bold text-white">
                    الأساسية
                  </span>
                ) : null}
              </div>
              {renderItemActions(item, i)}
            </div>
          ))}
        </div>
      ) : (
        // ── Read-only: primary hero + extra thumbnails ──
        <div className="space-y-3">
          <div className="relative w-40 sm:w-48">
            <div className="aspect-square w-full overflow-hidden rounded-xl border border-[#efe3d6] bg-[#faf6f1]">
              {/* eslint-disable-next-line @next/next/no-img-element -- Supabase Storage public URL, not a Next static asset */}
              <img src={primary!.url} alt="الصورة الرئيسية للمنتج" loading="lazy" className="block h-full w-full object-cover" />
            </div>
            <span className="absolute right-1.5 top-1.5 rounded-full bg-brand px-2 py-0.5 text-[10px] font-bold text-white">
              الأساسية
            </span>
          </div>

          {extras.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs text-muted">صور إضافية ({extras.length})</p>
              <div className="flex flex-wrap gap-2">
                {extras.map((item, i) => (
                  <div key={item.id ?? item.url} className="h-16 w-16 overflow-hidden rounded-lg border border-[#efe3d6] bg-[#faf6f1]">
                    {/* eslint-disable-next-line @next/next/no-img-element -- Supabase Storage public URL */}
                    <img src={item.url} alt={`صورة إضافية ${i + 1}`} loading="lazy" className="block h-full w-full object-cover" />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}

      {children ? <div className="border-t border-[#efe3d6] pt-3">{children}</div> : null}
    </section>
  );
}
