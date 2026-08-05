"use client";
// Malikas catalog results + product preview (Phase UI.3C.1).
//
// The interactive half of /v2/catalog: the desktop table, the mobile cards, and
// the product preview built on the shared CatalogPreviewDialog — the same
// approved experience as the Shopify catalog (bottom sheet on mobile, centered
// modal on desktop, shared fullscreen image lightbox).
//
// It receives ONLY MasterCatalogPreviewItem values, an explicit whitelist that
// the view layer produced: normalized approval/completeness states rather than
// the raw approval text, an already-validated discount, and a detail href that
// preserves the current query/filter/sort/page. It performs no fetch, holds no
// timer/polling/subscription, and does no filtering, sorting or pagination —
// all of that stays on the server.

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import {
  getCompletenessLabel,
  getPreviewApprovalLabel,
  getPreviewItemDisplayName,
  type MasterCatalogPreviewItem,
} from "@/lib/catalog-v2/master-catalog-view";
import { CatalogPreviewDialog, ImagePlaceholder, PreviewField } from "@/components/v2/catalog/CatalogPreviewDialog";

function money(value: number): string {
  return `${value} ر.ق`;
}

function hasText(v: string | null): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function Thumb({ item }: { item: MasterCatalogPreviewItem }) {
  if (!hasText(item.imageUrl)) return <ImagePlaceholder />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- catalog thumbnails use the stored URL directly; no next/image remote config here.
    <img
      src={item.imageUrl as string}
      alt=""
      loading="lazy"
      className="h-12 w-12 rounded-lg border border-[#efe3d6] object-cover"
    />
  );
}

function PriceCell({ item }: { item: MasterCatalogPreviewItem }) {
  // discountPrice is null unless the view layer validated it, so a strikethrough
  // can never be shown for a bogus discount.
  if (typeof item.discountPrice === "number" && typeof item.price === "number") {
    return (
      <span className="inline-flex flex-wrap items-baseline gap-1.5">
        <span className="text-xs text-muted line-through">{money(item.price)}</span>
        <span className="font-semibold text-emerald-700">{money(item.discountPrice)}</span>
      </span>
    );
  }
  if (typeof item.price === "number") return <span className="text-ink">{money(item.price)}</span>;
  return <span className="text-rose-600">—</span>;
}

function CompletenessBadge({ item }: { item: MasterCatalogPreviewItem }) {
  const complete = item.completenessStatus === "complete";
  return (
    <span
      className={
        "inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium " +
        (complete ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700")
      }
    >
      {getCompletenessLabel(item.completenessStatus)}
    </span>
  );
}

function ApprovalBadge({ item }: { item: MasterCatalogPreviewItem }) {
  const ok = item.approvalStatus === "approved";
  return (
    <span
      className={
        "inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium " +
        (ok ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700")
      }
    >
      {getPreviewApprovalLabel(item)}
    </span>
  );
}

// ── Product preview dialog ───────────────────────────────────────────────────

function PreviewDialog({ item, onClose }: { item: MasterCatalogPreviewItem; onClose: () => void }) {
  return (
    <CatalogPreviewDialog
      titleId="master-preview-title"
      title={getPreviewItemDisplayName(item)}
      imageUrl={item.imageUrl}
      onClose={onClose}
      footer={
        <Link href={item.detailHref} className="btn-ghost w-full">
          فتح صفحة المنتج
        </Link>
      }
    >
      {/* Catalog-safe fields only */}
      <div className="grid grid-cols-2 gap-3">
        <PreviewField label="الاسم العربي" value={hasText(item.nameAr) ? (item.nameAr as string) : "—"} />
        <PreviewField label="الاسم الإنجليزي" value={hasText(item.nameEn) ? (item.nameEn as string) : "—"} />
        <PreviewField label="SKU" value={hasText(item.sku) ? (item.sku as string) : "—"} />
        <PreviewField label="الباركود" value={hasText(item.barcode) ? (item.barcode as string) : "—"} />
        <PreviewField label="السعر الأساسي" value={typeof item.price === "number" ? money(item.price) : "—"} />
        <PreviewField
          label="سعر الخصم"
          value={typeof item.discountPrice === "number" ? money(item.discountPrice) : "—"}
        />
        <PreviewField label="عدد الخيارات" value={`${item.variantCount}`} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <ApprovalBadge item={item} />
        <CompletenessBadge item={item} />
      </div>
    </CatalogPreviewDialog>
  );
}

// ── Results list ─────────────────────────────────────────────────────────────

export default function MasterCatalogResults({ items }: { items: MasterCatalogPreviewItem[] }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const open = useCallback((key: string, el: HTMLElement | null) => {
    triggerRef.current = el;
    setOpenKey(key);
  }, []);

  const close = useCallback(() => {
    setOpenKey(null);
    // Return focus to whatever opened the dialog.
    triggerRef.current?.focus();
    triggerRef.current = null;
  }, []);

  const active = items.find((i) => i.key === openKey) ?? null;

  return (
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
              <th className="px-4 py-3 font-medium">الاعتماد</th>
              <th className="px-4 py-3 font-medium">الحالة</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={item.key}
                role="button"
                tabIndex={0}
                aria-haspopup="dialog"
                aria-label={`عرض تفاصيل ${getPreviewItemDisplayName(item)}`}
                onClick={(e) => open(item.key, e.currentTarget)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    open(item.key, e.currentTarget);
                  }
                }}
                className="cursor-pointer border-b border-[#f5ece1] last:border-0 hover:bg-[#fffaf4] focus:bg-[#fffaf4] focus:outline-2 focus:outline-brand"
              >
                <td className="px-4 py-3">
                  <Thumb item={item} />
                </td>
                <td className="px-4 py-3 font-medium text-ink">{getPreviewItemDisplayName(item)}</td>
                <td className="px-4 py-3 text-muted">{hasText(item.sku) ? item.sku : "—"}</td>
                <td className="px-4 py-3 text-muted">{hasText(item.barcode) ? item.barcode : "—"}</td>
                <td className="px-4 py-3">
                  <PriceCell item={item} />
                </td>
                <td className="px-4 py-3 text-muted">{item.variantCount}</td>
                <td className="px-4 py-3">
                  <ApprovalBadge item={item} />
                </td>
                <td className="px-4 py-3">
                  <CompletenessBadge item={item} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="space-y-3 md:hidden">
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-haspopup="dialog"
            aria-label={`عرض تفاصيل ${getPreviewItemDisplayName(item)}`}
            onClick={(e) => open(item.key, e.currentTarget)}
            className="card flex w-full gap-3 p-3 text-right"
          >
            <Thumb item={item} />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-start justify-between gap-2">
                <span className="truncate font-medium text-ink">{getPreviewItemDisplayName(item)}</span>
                <CompletenessBadge item={item} />
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted">
                <span>SKU: {hasText(item.sku) ? item.sku : "—"}</span>
                <span>باركود: {hasText(item.barcode) ? item.barcode : "—"}</span>
                <span>الخيارات: {item.variantCount}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm">
                  <PriceCell item={item} />
                </div>
                <ApprovalBadge item={item} />
              </div>
            </div>
          </button>
        ))}
      </div>

      {active !== null ? <PreviewDialog item={active} onClose={close} /> : null}
    </>
  );
}
