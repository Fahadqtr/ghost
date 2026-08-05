"use client";
// Shopify catalog results + product preview (Phase UI.3C.1).
//
// The interactive half of /v2/catalog/shopify: the desktop table, the mobile
// cards, and the product preview built on the shared CatalogPreviewDialog
// (bottom sheet on mobile, centered modal on desktop, with the shared
// fullscreen image lightbox).
//
// It receives ONLY ShopifyPreviewItem values, which the view layer has already
// stripped of every Shopify identifier (product / variant / inventory-item GID)
// and of the raw matchReason — so no such value is ever serialized into the HTML
// payload. It derives no match state of its own, performs no fetch, and holds no
// timer, polling or subscription. Presence/match/status text comes from the same
// fixed label helpers the server side uses.

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import {
  getMatchStatusExplanation,
  getMatchStatusLabel,
  getPresenceStatusLabel,
  getPreviewDisplayName,
  getShopifyStatusLabel,
  previewProductHref,
  type ShopifyPreviewItem,
} from "@/lib/catalog-v2/shopify-catalog-view";
import { CatalogPreviewDialog, ImagePlaceholder, PreviewField } from "@/components/v2/catalog/CatalogPreviewDialog";

function money(value: number): string {
  return `${value} ر.ق`;
}

function hasText(v: string | null): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

// ── Shared presentational bits ───────────────────────────────────────────────

function Thumb({ item }: { item: ShopifyPreviewItem }) {
  if (!hasText(item.imageUrl)) return <ImagePlaceholder />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- catalog thumbnails use the stored URL directly; no next/image remote config here.
    <img
      src={item.imageUrl as string}
      alt=""
      loading="lazy"
      className="h-14 w-14 rounded-lg border border-[#efe3d6] object-cover"
    />
  );
}

function PresenceBadge({ item }: { item: ShopifyPreviewItem }) {
  const tone =
    item.presenceStatus === "present"
      ? "bg-emerald-50 text-emerald-700"
      : item.presenceStatus === "missing"
        ? "bg-rose-50 text-rose-700"
        : "bg-slate-100 text-slate-600";
  return (
    <span className={"inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium " + tone}>
      {getPresenceStatusLabel(item.presenceStatus)}
    </span>
  );
}

function MatchBadge({ item }: { item: ShopifyPreviewItem }) {
  const tone =
    item.matchStatus === "matched_sku" || item.matchStatus === "matched_barcode"
      ? "bg-emerald-50 text-emerald-700"
      : item.matchStatus === "ambiguous"
        ? "bg-amber-50 text-amber-800"
        : item.matchStatus === "unmatched"
          ? "bg-rose-50 text-rose-700"
          : "bg-slate-100 text-slate-600";
  return (
    <span className={"inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium " + tone}>
      {getMatchStatusLabel(item.matchStatus)}
    </span>
  );
}

function ShopifyStatusBadge({ item }: { item: ShopifyPreviewItem }) {
  const tone =
    item.shopifyStatus === "active"
      ? "bg-emerald-50 text-emerald-700"
      : item.shopifyStatus === "draft"
        ? "bg-sky-50 text-sky-700"
        : "bg-slate-100 text-slate-600";
  return (
    <span className={"inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium " + tone}>
      {getShopifyStatusLabel(item.shopifyStatus)}
    </span>
  );
}

// ── Product preview dialog ──────────────────────────────────────────────────

function PreviewDialog({ item, onClose }: { item: ShopifyPreviewItem; onClose: () => void }) {
  const explanation = getMatchStatusExplanation(item.matchStatus);

  return (
    <CatalogPreviewDialog
      titleId="shopify-preview-title"
      title={getPreviewDisplayName(item)}
      imageUrl={item.imageUrl}
      onClose={onClose}
      footer={
        <Link href={previewProductHref(item)} className="btn-ghost w-full">
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
        <PreviewField label="السعر" value={typeof item.price === "number" ? money(item.price) : "—"} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <PresenceBadge item={item} />
        <MatchBadge item={item} />
        <ShopifyStatusBadge item={item} />
      </div>

      {/* Fixed explanation for the duplicate-match state. */}
      {explanation !== null ? (
        <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-800">{explanation}</p>
      ) : null}
    </CatalogPreviewDialog>
  );
}

// ── Results list ─────────────────────────────────────────────────────────────

export default function ShopifyCatalogResults({ items }: { items: ShopifyPreviewItem[] }) {
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
            {items.map((item) => (
              <tr
                key={item.key}
                role="button"
                tabIndex={0}
                aria-haspopup="dialog"
                aria-label={`عرض تفاصيل ${getPreviewDisplayName(item)}`}
                onClick={(e) => open(item.key, e.currentTarget)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    open(item.key, e.currentTarget);
                  }
                }}
                className="cursor-pointer border-b border-[#f5ece1] last:border-0 hover:bg-[#fffaf4] focus:bg-[#fffaf4] focus:outline-2 focus:outline-brand"
              >
                <td className="px-3 py-2.5">
                  <Thumb item={item} />
                </td>
                <td className="px-3 py-2.5 font-medium text-ink">{getPreviewDisplayName(item)}</td>
                <td className="px-3 py-2.5 text-muted">{hasText(item.sku) ? item.sku : "—"}</td>
                <td className="px-3 py-2.5 text-muted">{hasText(item.barcode) ? item.barcode : "—"}</td>
                <td className="px-3 py-2.5">
                  {typeof item.price === "number" ? (
                    <span className="text-ink">{money(item.price)}</span>
                  ) : (
                    <span className="text-rose-600">—</span>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  <PresenceBadge item={item} />
                </td>
                <td className="px-3 py-2.5">
                  <MatchBadge item={item} />
                </td>
                <td className="px-3 py-2.5">
                  <ShopifyStatusBadge item={item} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="space-y-2.5 md:hidden">
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-haspopup="dialog"
            aria-label={`عرض تفاصيل ${getPreviewDisplayName(item)}`}
            onClick={(e) => open(item.key, e.currentTarget)}
            className="card flex w-full gap-3 p-3 text-right"
          >
            <Thumb item={item} />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="truncate font-medium text-ink">{getPreviewDisplayName(item)}</div>
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted">
                <span>SKU: {hasText(item.sku) ? item.sku : "—"}</span>
                <span>باركود: {hasText(item.barcode) ? item.barcode : "—"}</span>
                <span>السعر: {typeof item.price === "number" ? money(item.price) : "—"}</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <PresenceBadge item={item} />
                <MatchBadge item={item} />
                <ShopifyStatusBadge item={item} />
              </div>
            </div>
          </button>
        ))}
      </div>

      {active !== null ? <PreviewDialog item={active} onClose={close} /> : null}
    </>
  );
}
