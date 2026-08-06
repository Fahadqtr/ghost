"use client";

// Similar-products panel for the AI creator (Phase UI.5, card revision).
// Renders the duplicate report as PRODUCT CARDS — one card per catalog
// product with its merged similarity reasons — and opens the shared
// CatalogPreviewDialog (the same shell + lightbox the V2 catalogs use) for a
// full preview. Data arrives fully hydrated and whitelisted from the server
// (SimilarProductCard); this component performs no fetching.

import { useState } from "react";
import Link from "next/link";
import {
  CatalogPreviewDialog,
  ImagePlaceholder,
  PreviewField,
} from "@/components/v2/catalog/CatalogPreviewDialog";
import type { SimilarProductCard } from "@/lib/products/similar-products-read";
import type { DuplicateLevel } from "@/lib/products/duplicate-detect";

const VISIBLE_DEFAULT = 5;

/** Fixed reason labels — the fixed-vocabulary keys are never shown raw. */
const REASON_LABELS: Record<string, string> = {
  same_sku: "تطابق قوي (نفس SKU)",
  same_barcode: "تطابق قوي (نفس الباركود)",
  same_identity: "تطابق قوي (نفس الهوية)",
  similar_name: "اسم مشابه",
  same_brand: "نفس البراند",
  same_size: "نفس الحجم",
  same_shade: "نفس الدرجة",
};

function money(value: number): string {
  return `${value} ر.ق`;
}

function reasonsLine(card: SimilarProductCard): string {
  return card.reasons.map((r) => REASON_LABELS[r] ?? "تشابه").join(" · ");
}

function cardTitle(card: SimilarProductCard): string {
  return card.nameAr || card.nameEn || card.sku || "منتج في الكتالوج";
}

function completenessLabel(card: SimilarProductCard): string {
  return card.sku && card.barcode && card.imageUrl ? "مكتمل" : "ناقص";
}

export default function SimilarProducts({
  level,
  cards,
  total,
}: {
  level: DuplicateLevel;
  cards: SimilarProductCard[];
  total: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const [preview, setPreview] = useState<SimilarProductCard | null>(null);

  if (level === "none") {
    return <p className="text-sm text-emerald-700">لا يوجد تطابق في الكتالوج.</p>;
  }

  const visible = showAll ? cards : cards.slice(0, VISIBLE_DEFAULT);
  const hiddenCount = cards.length - visible.length;
  const beyondHydrated = total - cards.length;

  return (
    <div className="space-y-3">
      <div
        className={
          "rounded-lg border p-3 text-sm font-semibold " +
          (level === "exact"
            ? "border-rose-200 bg-rose-50 text-rose-700"
            : "border-amber-200 bg-amber-50 text-amber-800")
        }
      >
        {level === "exact" ? "منتج مطابق موجود — لا يمكن الحفظ." : "منتج مشابه — راجعه قبل الحفظ."}
      </div>

      {cards.length === 0 ? (
        <p className="text-xs text-muted">تعذّر عرض بطاقات المنتجات المشابهة — التحذير أعلاه ما زال قائمًا.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((card) => (
            <div
              key={card.id}
              role="button"
              tabIndex={0}
              aria-haspopup="dialog"
              onClick={() => setPreview(card)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setPreview(card);
                }
              }}
              className={
                "cursor-pointer rounded-xl border bg-white p-3 text-right transition-shadow hover:shadow-md " +
                (card.level === "exact" ? "border-rose-300" : "border-[#efe3d6]")
              }
            >
              <div className="flex items-start gap-3">
                {card.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- catalog image URL, same as the V2 catalog cards
                  <img
                    src={card.imageUrl}
                    alt={cardTitle(card)}
                    loading="lazy"
                    className="h-20 w-20 shrink-0 rounded-lg border border-[#efe3d6] object-cover"
                  />
                ) : (
                  <ImagePlaceholder className="h-20 w-20 shrink-0" />
                )}
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="truncate text-sm font-semibold text-ink">{cardTitle(card)}</div>
                  {card.nameEn ? (
                    <div className="truncate text-xs text-muted" dir="ltr">
                      {card.nameEn}
                    </div>
                  ) : null}
                  <div className="text-xs text-muted" dir="ltr">
                    {card.sku ?? "—"}
                    {card.barcode ? ` · ${card.barcode}` : ""}
                  </div>
                  <div className="flex flex-wrap items-center gap-1 text-xs text-muted">
                    {card.brand ? <span>{card.brand}</span> : null}
                    {card.size ? <span>· {card.size}</span> : null}
                    {typeof card.price === "number" ? <span>· {money(card.price)}</span> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={
                        "inline-block rounded-full px-2 py-0.5 text-[11px] font-medium " +
                        (card.approved ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700")
                      }
                    >
                      {card.approved ? "معتمد" : "غير معتمد"}
                    </span>
                    {card.level === "exact" ? (
                      <span className="inline-block rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700">
                        منتج مطابق موجود
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2 border-t border-[#f5ece1] pt-2">
                <span className="text-[11px] text-muted">{reasonsLine(card)}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPreview(card);
                  }}
                  className="btn-ghost shrink-0 text-xs"
                >
                  عرض المنتج
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {hiddenCount > 0 && !showAll ? (
          <button type="button" onClick={() => setShowAll(true)} className="btn-ghost text-xs">
            عرض المزيد ({hiddenCount})
          </button>
        ) : null}
        {beyondHydrated > 0 ? (
          <span className="text-xs text-muted">وتوجد {beyondHydrated} نتائج إضافية مشابهة في الكتالوج.</span>
        ) : null}
      </div>

      {preview ? (
        <CatalogPreviewDialog
          titleId="similar-product-preview-title"
          title={cardTitle(preview)}
          imageUrl={preview.imageUrl}
          onClose={() => setPreview(null)}
          footer={
            <Link href={preview.detailHref} className="btn-ghost w-full">
              فتح صفحة المنتج
            </Link>
          }
        >
          <PreviewField label="الاسم العربي" value={preview.nameAr ?? "—"} />
          <PreviewField label="الاسم الإنجليزي" value={preview.nameEn ?? "—"} />
          <PreviewField label="SKU" value={preview.sku ?? "—"} />
          <PreviewField label="الباركود" value={preview.barcode ?? "—"} />
          <PreviewField label="البراند" value={preview.brand ?? "—"} />
          <PreviewField label="الحجم" value={preview.size ?? "—"} />
          <PreviewField label="الفئة" value={preview.category ?? "—"} />
          <PreviewField label="السعر الأساسي" value={typeof preview.price === "number" ? money(preview.price) : "—"} />
          <PreviewField
            label="سعر الخصم"
            value={typeof preview.discountPrice === "number" ? money(preview.discountPrice) : "—"}
          />
          <PreviewField label="عدد الخيارات" value={`${preview.variantCount}`} />
          <PreviewField label="الاعتماد" value={preview.approved ? "معتمد" : "غير معتمد"} />
          <PreviewField label="الاكتمال" value={completenessLabel(preview)} />
          <PreviewField label="سبب التشابه" value={reasonsLine(preview)} />
          <PreviewField label="الوصف (عربي)" value={preview.descriptionAr ?? "—"} />
          <PreviewField label="الوصف (إنجليزي)" value={preview.descriptionEn ?? "—"} />
        </CatalogPreviewDialog>
      ) : null}
    </div>
  );
}
