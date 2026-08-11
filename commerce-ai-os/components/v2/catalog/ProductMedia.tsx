// Malikas V2 — Product media viewer (UX.4C-1, +controls slot UX.4C-2).
//
// A shared, presentational component that renders a product's photos from a
// pre-computed ProductMediaState. It holds NO state and does NO data access —
// the caller reads the media and passes the state in. It renders the DISPLAY
// only (primary + badge + extras + empty state); any write controls are supplied
// by the caller through the optional `children` footer slot (the V2 edit form
// passes upload/replace/delete controls there). The detail page passes no
// children and gets the pure read-only view. Because it is JSX over props (no
// client directive, no data access, no async), it renders in BOTH the server
// detail page and the client edit form. RTL, mobile-first.

import type { ReactNode } from "react";
import type { ProductMediaState } from "@/lib/products/product-media";

export default function ProductMedia({
  state,
  children,
}: {
  state: ProductMediaState;
  /** Optional controls footer (edit mode). Read-only callers omit it. */
  children?: ReactNode;
}) {
  const { primary, images } = state;
  const extras = images.slice(1); // images[0] is always the primary when present

  return (
    <section dir="rtl" className="card space-y-3">
      <h2 className="text-sm font-semibold text-ink">صور المنتج</h2>

      {primary ? (
        <div className="space-y-3">
          <div className="relative w-40 sm:w-48">
            <div className="aspect-square w-full overflow-hidden rounded-xl border border-[#efe3d6] bg-[#faf6f1]">
              {/* eslint-disable-next-line @next/next/no-img-element -- Supabase Storage public URL, not a Next static asset */}
              <img
                src={primary.url}
                alt="الصورة الرئيسية للمنتج"
                loading="lazy"
                className="block h-full w-full object-cover"
              />
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
                  <div
                    key={item.id ?? item.url}
                    className="h-16 w-16 overflow-hidden rounded-lg border border-[#efe3d6] bg-[#faf6f1]"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- Supabase Storage public URL */}
                    <img
                      src={item.url}
                      alt={`صورة إضافية ${i + 1}`}
                      loading="lazy"
                      className="block h-full w-full object-cover"
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-[#efe3d6] bg-[#faf6f1] px-3 py-6 text-center text-sm text-muted">
          لا توجد صور لهذا المنتج
        </p>
      )}

      {children ? <div className="border-t border-[#efe3d6] pt-3">{children}</div> : null}
    </section>
  );
}
