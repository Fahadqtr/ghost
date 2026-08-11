"use client";

// Malikas V2 — Product media editor (UX.4C-2). The write-mode wrapper around the
// read-only <ProductMedia> display. It owns NO storage/DB logic: every mutation
// goes through the thin server actions (uploadProductMedia / removeProductMedia),
// which reuse the existing image cores and return a fresh ProductMediaState. The
// client NEVER touches Storage directly and never holds a service-role client.
//
// Controlled component: the parent form owns the media state (so it can sync
// products.image_url into the completeness widget); this wrapper reports every
// successful change via `onChange`. While an upload is in flight it shows a local
// preview of the picked file. Confirm-before-delete. RTL, mobile-first.
//
// Scope (this PR): upload, replace-primary, delete-primary. Extra images have no
// manual primary-select and their ordering is left untouched.

import { useRef, useState, useTransition } from "react";
import ProductMedia from "@/components/v2/catalog/ProductMedia";
import { uploadProductMedia, removeProductMedia } from "@/app/(v2)/v2/catalog/media-actions";
import type { ProductMediaItem, ProductMediaState } from "@/lib/products/product-media";

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif";

export default function ProductMediaEditor({
  productId,
  state,
  onChange,
}: {
  productId: string;
  state: ProductMediaState;
  onChange: (next: ProductMediaState) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const hasPrimary = state.primary !== null;

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file later
    if (!file) return;
    setError(null);

    const localUrl = URL.createObjectURL(file);
    setPreview(localUrl);

    const fd = new FormData();
    fd.set("productId", productId);
    fd.set("file", file);

    startTransition(async () => {
      const res = await uploadProductMedia(fd);
      URL.revokeObjectURL(localUrl);
      setPreview(null);
      if ("error" in res) setError(res.error);
      else onChange(res.data);
    });
  }

  function onDeletePrimary() {
    const primary = state.primary;
    if (!primary) return;
    if (!window.confirm("سيتم حذف الصورة الرئيسية. متابعة؟")) return;
    setError(null);
    startTransition(async () => {
      const res = await removeProductMedia(productId, primary.url);
      if ("error" in res) setError(res.error);
      else onChange(res.data);
    });
  }

  // While uploading, show the picked file as the primary so the change is
  // visible immediately; the real state replaces it on success.
  const previewItem: ProductMediaItem | null = preview
    ? { id: null, url: preview, filename: null, isPrimary: true, sortOrder: 0 }
    : null;
  const displayState: ProductMediaState = previewItem
    ? { primary: previewItem, images: [previewItem, ...state.images.filter((i) => !i.isPrimary)] }
    : state;

  const btn = "px-3 py-1.5 text-xs disabled:opacity-50";

  return (
    <ProductMedia state={displayState}>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={`btn-primary ${btn}`}
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {busy ? "جارٍ الرفع…" : hasPrimary ? "استبدال الصورة الرئيسية" : "رفع صورة"}
          </button>
          {hasPrimary ? (
            <button type="button" className={`btn-ghost text-rose-600 ${btn}`} disabled={busy} onClick={onDeletePrimary}>
              حذف الصورة الرئيسية
            </button>
          ) : null}
          <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" onChange={onPickFile} disabled={busy} />
        </div>
        <p className="text-[11px] text-muted">JPG / PNG / WebP / GIF · بحد أقصى 10MB — الصورة الجديدة تصبح الأساسية.</p>
        {error ? (
          <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {error}
          </p>
        ) : null}
      </div>
    </ProductMedia>
  );
}
