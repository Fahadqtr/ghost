"use client";
// Shared catalog preview chrome (Phase UI.3C.1).
//
// The dialog shell and the fullscreen image lightbox used by BOTH catalog
// previews — Shopify (/v2/catalog/shopify) and Malikas (/v2/catalog). The
// behaviour here is exactly the behaviour approved for the Shopify preview; it
// was extracted verbatim so the two catalogs cannot drift apart, not rewritten.
//
// Layout: a bottom sheet on mobile, a centered modal on desktop.
// Closing: the close button, a backdrop click, or Escape — and Escape closes the
// lightbox first when it is open, so one press never dismisses both.
// While open the background is scroll-locked and focus moves to the close
// button; returning focus to the trigger is the caller's job (it owns the row).
//
// It is presentation-only: no fetch, no timer, no polling, no subscription, and
// it receives only the already-narrowed, client-safe fields its callers pass in.

import { useEffect, useRef, useState } from "react";

const MAX_ZOOM = 4;
const MIN_ZOOM = 1;
const ZOOM_STEP = 0.5;

export function ImagePlaceholder({ className = "h-14 w-14" }: { className?: string }) {
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

// ── Fullscreen image lightbox ────────────────────────────────────────────────

function ImageLightbox({ imageUrl, alt, onClose }: { imageUrl: string; alt: string; onClose: () => void }) {
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
      <div className="flex shrink-0 items-center justify-between gap-2 p-3" onClick={(e) => e.stopPropagation()}>
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

      {/* Image stage — scrollable so a zoomed image is panned instead of
          spilling off a phone screen. */}
      <div className="min-h-0 flex-1 overflow-auto p-3" onClick={onClose}>
        <div className="flex min-h-full min-w-full items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element -- full-size view of the stored URL; no next/image remote config here. */}
          <img
            src={imageUrl}
            alt={alt}
            onClick={(e) => e.stopPropagation()}
            style={{ transform: `scale(${zoom})` }}
            className="max-h-[78vh] max-w-full origin-center object-contain transition-transform"
          />
        </div>
      </div>
    </div>
  );
}

// ── Preview dialog shell ─────────────────────────────────────────────────────

export function CatalogPreviewDialog({
  titleId,
  title,
  imageUrl,
  onClose,
  children,
  footer,
}: {
  titleId: string;
  title: string;
  /** null / empty → a placeholder is shown and the lightbox cannot be opened. */
  imageUrl: string | null;
  onClose: () => void;
  /** The catalog-safe field block. */
  children: React.ReactNode;
  /** The secondary action (the link to the full product page). */
  footer?: React.ReactNode;
}) {
  const [lightbox, setLightbox] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const imageAvailable = typeof imageUrl === "string" && imageUrl.trim().length > 0;

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

  // Lock background scrolling for as long as the dialog is mounted.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
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
            <h2 id={titleId} className="font-serif text-lg font-semibold text-ink">
              {title}
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
                <img src={imageUrl as string} alt={title} className="h-44 w-44 rounded-lg object-contain" />
              </button>
            ) : (
              <ImagePlaceholder className="h-44 w-44" />
            )}
          </div>

          {children}

          {footer !== undefined ? <div className="mt-5">{footer}</div> : null}
        </div>
      </div>

      {lightbox && imageAvailable ? (
        <ImageLightbox imageUrl={imageUrl as string} alt={title} onClose={() => setLightbox(false)} />
      ) : null}
    </>
  );
}

/** A labelled read-only field inside a preview dialog. */
export function PreviewField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-muted">{label}</span>
      <span className="text-sm text-ink">{value}</span>
    </div>
  );
}
