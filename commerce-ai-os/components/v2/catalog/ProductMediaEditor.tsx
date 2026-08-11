"use client";

// Malikas V2 — Product media editor (UX.4C-2 writes → 4C-3 advanced controls).
// The write-mode wrapper around the read-only <ProductMedia> display. It owns NO
// storage/DB logic: every mutation goes through the thin server actions
// (uploadProductMedia / removeProductMedia / setPrimaryProductMedia /
// reorderProductMedia), which reuse the existing cores + the shared reader and
// return a fresh ProductMediaState. The client NEVER touches Storage/DB directly
// and never holds a service-role client.
//
// Controlled component: the parent form owns the media state (so it can sync
// products.image_url into the completeness widget); this wrapper reports every
// successful change via `onChange`. While an upload is in flight it shows a local
// preview of the picked file. Confirm-before-delete. RTL, mobile-first.
//
// Scope (this PR): upload, replace-primary (global), and per-image set-primary,
// delete, and one-slot up/down move.

import { useRef, useState, useTransition } from "react";
import ProductMedia from "@/components/v2/catalog/ProductMedia";
import {
  uploadProductMedia,
  removeProductMedia,
  setPrimaryProductMedia,
  reorderProductMedia,
} from "@/app/(v2)/v2/catalog/media-actions";
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

  /** Run a media action and fold its result into the parent state. */
  function run(action: () => Promise<{ data: ProductMediaState } | { error: string }>) {
    setError(null);
    startTransition(async () => {
      const res = await action();
      if ("error" in res) setError(res.error);
      else onChange(res.data);
    });
  }

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

  function onSetPrimary(imageId: string) {
    run(() => setPrimaryProductMedia(productId, imageId));
  }

  function onDelete(item: ProductMediaItem) {
    const msg = item.isPrimary ? "سيتم حذف الصورة الرئيسية. متابعة؟" : "سيتم حذف هذه الصورة. متابعة؟";
    if (!window.confirm(msg)) return;
    run(() => removeProductMedia(productId, item.url));
  }

  function onMove(imageId: string, direction: "up" | "down") {
    run(() => reorderProductMedia(productId, imageId, direction));
  }

  // While uploading, show the picked file as the primary so the change is
  // visible immediately; the real state replaces it on success.
  const previewItem: ProductMediaItem | null = preview
    ? { id: null, url: preview, filename: null, isPrimary: true, sortOrder: 0 }
    : null;
  const displayState: ProductMediaState = previewItem
    ? { primary: previewItem, images: [previewItem, ...state.images.filter((i) => !i.isPrimary)] }
    : state;

  const extras = displayState.images.filter((i) => !i.isPrimary && typeof i.id === "string");
  const smBtn = "btn-ghost px-2 py-0.5 text-[11px] disabled:opacity-50";

  // Per-image actions rendered under each thumbnail in the edit grid. The
  // transient upload preview (blob: url, id null) gets none.
  function itemActions(item: ProductMediaItem) {
    if (item.url.startsWith("blob:")) return null;
    const extraIdx = item.id ? extras.findIndex((e) => e.id === item.id) : -1;
    return (
      <div className="flex flex-wrap items-center gap-1">
        {!item.isPrimary && item.id ? (
          <button type="button" className={smBtn} disabled={busy} onClick={() => onSetPrimary(item.id!)}>
            تعيين رئيسية
          </button>
        ) : null}
        {!item.isPrimary && item.id ? (
          <>
            <button
              type="button"
              className={smBtn}
              disabled={busy || extraIdx <= 0}
              title="تقديم"
              onClick={() => onMove(item.id!, "up")}
            >
              ↑
            </button>
            <button
              type="button"
              className={smBtn}
              disabled={busy || extraIdx < 0 || extraIdx >= extras.length - 1}
              title="تأخير"
              onClick={() => onMove(item.id!, "down")}
            >
              ↓
            </button>
          </>
        ) : null}
        <button type="button" className={`${smBtn} text-rose-600`} disabled={busy} onClick={() => onDelete(item)}>
          حذف
        </button>
      </div>
    );
  }

  return (
    <ProductMedia state={displayState} renderItemActions={itemActions}>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {busy ? "جارٍ الرفع…" : hasPrimary ? "استبدال الصورة الرئيسية" : "رفع صورة"}
          </button>
          <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" onChange={onPickFile} disabled={busy} />
        </div>
        <p className="text-[11px] text-muted">
          JPG / PNG / WebP / GIF · بحد أقصى 10MB — الصورة المرفوعة تصبح الأساسية. استخدم «تعيين رئيسية» لاختيار صورة أخرى.
        </p>
        {error ? (
          <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {error}
          </p>
        ) : null}
      </div>
    </ProductMedia>
  );
}
