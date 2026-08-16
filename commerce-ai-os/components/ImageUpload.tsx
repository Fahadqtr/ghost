"use client";

import { useState } from "react";
import type { Locale } from "@/lib/i18n";
import { uploadProductImage } from "@/app/(app)/products/image-actions";

// Display-only bucket name for the help text. Uploads no longer write from the
// browser — they route through the certified server action below.
const BUCKET = "product-images";

export default function ImageUpload({
  products,
  locale = "ar",
}: {
  products: { id: string; name_en: string | null }[];
  locale?: Locale;
}) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [productId, setProductId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true); setError(null); setUploadedUrl(null);

    try {
      // INT.1 — security closure: uploads route through the certified,
      // writer-gated imageStore (via the server action) instead of the previous
      // ungated browser Storage write + raw product_images insert. Every upload
      // links to a product (the server sets it primary, points products.image_url
      // at it, and logs a catalog task); the old "unattached" ungated write is
      // retired, so no duplicate write path remains.
      if (!productId) {
        setError(L("اختر منتجًا للربط أولاً.", "Select a product to attach first."));
        return;
      }
      const fd = new FormData();
      fd.append("file", file);
      fd.append("productId", productId);
      const r = await uploadProductImage(fd);
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setUploadedUrl(r.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : L("فشل الرفع.", "Upload failed."));
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  }

  return (
    <div className="card space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-ink">{L("رفع الصور", "Upload Images")}</h3>
        <p className="text-xs text-muted">
          {L("تُخزَّن في Supabase Storage (مخزن", "Stored in Supabase Storage (bucket")} <code>{BUCKET}</code>{L(") وتُربَط بـ", ") and linked to")} <code>product_images</code> {L("عند اختيار منتج.", "when a product is selected.")}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="label">{L("الربط بمنتج (اختياري)", "Attach to product (optional)")}</label>
          <select className="input" value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">{L("— بدون ربط، رفع فقط —", "— Don’t link, just upload —")}</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>{p.name_en ?? p.id}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">{L("ملف الصورة", "Image file")}</label>
          <input type="file" accept="image/*" onChange={onUpload} disabled={busy} className="block text-sm" />
        </div>
      </div>

      {busy ? <p className="text-sm text-muted">{L("جارٍ الرفع…", "Uploading…")}</p> : null}
      {error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p> : null}
      {uploadedUrl ? (
        <div className="flex items-center gap-3 rounded-lg bg-green-50 px-3 py-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={uploadedUrl} alt={L("الصورة المرفوعة", "uploaded")} className="h-12 w-12 rounded-sm object-cover" />
          <a href={uploadedUrl} target="_blank" rel="noreferrer" className="break-all text-xs text-green-700 underline">
            {uploadedUrl}
          </a>
        </div>
      ) : null}
    </div>
  );
}
