"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { uploadProductImage, removeProductImage } from "@/app/(app)/products/image-actions";

export interface ProductImageRow { url: string; is_primary: boolean | null }

const ACCEPTED = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX = 10 * 1024 * 1024;

export default function ProductImages({
  productId,
  imageUrl,
  images,
}: {
  productId: string;
  imageUrl: string | null;
  images: ProductImageRow[];
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // De-duplicated gallery: primary (image_url) first, then the rest.
  const urls: string[] = [];
  if (imageUrl) urls.push(imageUrl);
  for (const im of images) if (im.url && !urls.includes(im.url)) urls.push(im.url);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null); setMsg(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (!ACCEPTED.includes(file.type)) {
      setError(`Unsupported type "${file.type || "unknown"}". Use JPG, PNG, WebP or GIF.`);
      e.target.value = ""; return;
    }
    if (file.size > MAX) {
      setError(`File too large (${(file.size / 1048576).toFixed(1)} MB). Max 10 MB.`);
      e.target.value = ""; return;
    }
    const fd = new FormData();
    fd.set("file", file);
    fd.set("productId", productId);
    startTransition(async () => {
      const res = await uploadProductImage(fd);
      if (res?.error) setError(res.error);
      else { setMsg("Image uploaded ✓"); router.refresh(); }
      if (fileRef.current) fileRef.current.value = "";
    });
  }

  function onRemove(url: string) {
    if (!confirm("Remove this image?")) return;
    setError(null); setMsg(null);
    startTransition(async () => {
      const res = await removeProductImage(productId, url);
      if (res?.error) setError(res.error);
      else router.refresh();
    });
  }

  return (
    <div className="card space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-ink">Images</h3>
        <p className="text-xs text-muted">
          The first image is the primary (shown in the catalog). Upload to replace it; the new one becomes primary.
        </p>
      </div>

      {urls.length > 0 ? (
        <div className="flex flex-wrap gap-3">
          {urls.map((u, i) => (
            <div key={u} className="relative">
              <div className="h-24 w-24 overflow-hidden rounded-lg bg-slate-100 ring-1 ring-slate-200">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={u} alt={`image ${i + 1}`} loading="lazy" className="block h-full w-full object-cover" />
              </div>
              {i === 0 ? (
                <span className="absolute left-1 top-1 rounded bg-brand px-1.5 py-0.5 text-[10px] font-medium text-white">Primary</span>
              ) : null}
              <button
                type="button"
                onClick={() => onRemove(u)}
                disabled={busy}
                title="Remove"
                className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-white text-red-600 shadow ring-1 ring-slate-200 hover:bg-red-50 disabled:opacity-50"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex h-24 w-24 items-center justify-center rounded-lg bg-slate-50 text-slate-300">📦</div>
      )}

      <div className="flex flex-col gap-2 border-t border-slate-100 pt-3 sm:flex-row sm:items-center">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          onChange={onPick}
          disabled={busy}
          className="block text-sm"
        />
        {busy ? <span className="text-sm text-muted">Uploading…</span> : null}
      </div>

      {error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p> : null}
      {msg ? <p className="text-xs text-green-700">{msg}</p> : null}
      <p className="text-[11px] text-muted">Max 10 MB · JPG/PNG/WebP/GIF · HEIC (iPhone) isn’t supported by browsers — use JPEG.</p>
    </div>
  );
}
