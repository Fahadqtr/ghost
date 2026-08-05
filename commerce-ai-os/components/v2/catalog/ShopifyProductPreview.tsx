"use client";
// Shopify catalog results + product preview (Phase UI.3C.1).
//
// The interactive half of /v2/catalog/shopify: the desktop table, the mobile
// cards, the product preview dialog (bottom sheet on mobile, centered modal on
// desktop) and the fullscreen image lightbox.
//
// It receives ONLY ShopifyPreviewItem values, which the view layer has already
// stripped of every Shopify identifier (product / variant / inventory-item GID)
// and of the raw matchReason — so no such value is ever serialized into the HTML
// payload. It derives no match state of its own, performs no fetch, and holds no
// timer, polling or subscription. Presence/match/status text comes from the same
// fixed label helpers the server side uses.

import { useCallback, useEffect, useRef, useState } from "react";
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

const MAX_ZOOM = 4;
const MIN_ZOOM = 1;
const ZOOM_STEP = 0.5;

function money(value: number): string {
  return `${value} ر.ق`;
}

function hasText(v: string | null): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function hasImage(item: ShopifyPreviewItem): boolean {
  return hasText(item.imageUrl);
}

// ── Shared presentational bits ───────────────────────────────────────────────

function ImagePlaceholder({ className = "h-14 w-14" }: { className?: string }) {
  return (
    <div
      className={
        "flex items-center justify-center rounded-lg border border-[#efe3d6] bg-[#faf3ec] text-[#d9b48f] " + className
      }
    >
      <svg viewBox="0 0 24 24" width="40%" height="40%" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <circle cx="8.5" cy="9.5" r="1.6" />
        <path d="M21 16l-5-5-8 8" />
      </svg>
    </div>
  );
}

function Thumb({ item }: { item: ShopifyPreviewItem }) {
  if (!hasImage(item)) return <ImagePlaceholder />;
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

// ── Image lightbox ───────────────────────────────────────────────────────────

function Lightbox({ item, onClose }: { item: ShopifyPreviewItem; onClose: () => void }) {
  const [zoom, setZoom] = useState(1);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const zoomIn = () => setZoom((z) => Math.min(MAX_ZOOM, Math.round((z + ZOOM_STEP) * 10) / 10));
  const zoomOut = () => setZoom((z) => Math.max(MIN_ZOOM, Math.round((z - ZOOM_STEP) * 10) / 10));
  const zoomReset = () => setZoom(1);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="عرض الصورة بالحجم الكامل"
      className="fixed inset-0 z-50 flex flex-col bg-black/90"
      onClick={onClose}
    >
      {/* Toolbar */}
      <div
        className="flex shrink-0 items-center justify-between gap-2 p-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={zoomOut}
            disabled={zoom <= MIN_ZOOM}
            aria-label="تصغير"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-lg font-bold text-white disabled:opacity-40"
          >
            −
          </button>
          <button
            type="button"
            onClick={zoomIn}
            disabled={zoom >= MAX_ZOOM}
            aria-label="تكبير"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-lg font-bold text-white disabled:opacity-40"
          >
            +
          </button>
          <button
            type="button"
            onClick={zoomReset}
            aria-label="إعادة الحجم إلى 100%"
            className="rounded-full bg-white/15 px-3 py-2 text-xs font-semibold text-white"
          >
            100%
          </button>
          <span className="px-1 text-xs text-white/70" aria-live="polite">
            {Math.round(zoom * 100)}%
          </span>
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="إغلاق الصورة"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-xl leading-none text-white"
        >
          ×
        </button>
      </div>

      {/* Image stage — scrollable so a zoomed image can be panned instead of
          spilling off a phone screen. */}
      <div className="min-h-0 flex-1 overflow-auto p-3" onClick={onClose}>
        <div className="flex min-h-full min-w-full items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element -- full-size view of the stored URL; no next/image remote config here. */}
          <img
            src={item.imageUrl as string}
            alt={getPreviewDisplayName(item)}
            onClick={(e) => e.stopPropagation()}
            style={{ transform: `scale(${zoom})` }}
            className="max-h-[78vh] max-w-full origin-center object-contain transition-transform"
          />
        </div>
      </div>
    </div>
  );
}

// ── Product preview dialog ───────────────────────────────────────────────────

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-muted">{label}</span>
      <span className="text-sm text-ink">{value}</span>
    </div>
  );
}

function PreviewDialog({ item, onClose }: { item: ShopifyPreviewItem; onClose: () => void }) {
  const [lightbox, setLightbox] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const explanation = getMatchStatusExplanation(item.matchStatus);
  const imageAvailable = hasImage(item);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Escape closes the lightbox first, then the dialog.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (lightbox) setLightbox(false);
      else onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [lightbox, onClose]);

  return (
    <>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shopify-preview-title"
        className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
        onClick={onClose}
      >
        <div
          dir="rtl"
          onClick={(e) => e.stopPropagation()}
          className="max-h-[88vh] w-full overflow-y-auto rounded-t-2xl bg-white p-4 shadow-xl sm:max-w-lg sm:rounded-2xl"
        >
          {/* Header */}
          <div className="mb-3 flex items-start justify-between gap-3">
            <h2 id="shopify-preview-title" className="font-serif text-lg font-semibold text-ink">
              {getPreviewDisplayName(item)}
            </h2>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="إغلاق"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#e7d9c9] text-lg leading-none text-[#6b5344]"
            >
              ×
            </button>
          </div>

          {/* Image — tapping it opens the lightbox, but only when one exists. */}
          <div className="mb-4 flex justify-center">
            {imageAvailable ? (
              <button
                type="button"
                onClick={() => setLightbox(true)}
                aria-label="تكبير الصورة"
                className="rounded-xl border border-[#efe3d6] p-1"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- catalog image uses the stored URL directly. */}
                <img
                  src={item.imageUrl as string}
                  alt={getPreviewDisplayName(item)}
                  className="h-44 w-44 rounded-lg object-contain"
                />
              </button>
            ) : (
              <ImagePlaceholder className="h-44 w-44" />
            )}
          </div>

          {/* Catalog-safe fields only */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="الاسم العربي" value={hasText(item.nameAr) ? (item.nameAr as string) : "—"} />
            <Field label="الاسم الإنجليزي" value={hasText(item.nameEn) ? (item.nameEn as string) : "—"} />
            <Field label="SKU" value={hasText(item.sku) ? (item.sku as string) : "—"} />
            <Field label="الباركود" value={hasText(item.barcode) ? (item.barcode as string) : "—"} />
            <Field label="السعر" value={typeof item.price === "number" ? money(item.price) : "—"} />
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

          <div className="mt-5">
            <Link href={previewProductHref(item)} className="btn-ghost w-full">
              فتح صفحة المنتج
            </Link>
          </div>
        </div>
      </div>

      {lightbox && imageAvailable ? <Lightbox item={item} onClose={() => setLightbox(false)} /> : null}
    </>
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

  // Lock background scrolling while a dialog is open.
  useEffect(() => {
    if (openKey === null) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [openKey]);

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
