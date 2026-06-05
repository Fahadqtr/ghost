"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

const BUCKET = "product-images";

export default function ImageUpload({
  products,
}: {
  products: { id: string; name_en: string | null }[];
}) {
  const [productId, setProductId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true); setError(null); setUploadedUrl(null);

    try {
      const supabase = createClient();
      const path = `${productId || "unattached"}/${Date.now()}-${file.name}`;

      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, { upsert: false });

      if (upErr) {
        setError(
          `${upErr.message}. If the bucket is missing, create a public Storage bucket named "${BUCKET}" in Supabase.`
        );
        setBusy(false);
        return;
      }

      const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
      const url = pub.publicUrl;
      setUploadedUrl(url);

      // Link to product_images (and set as primary if the product has none yet).
      if (productId) {
        const { count } = await supabase
          .from("product_images")
          .select("*", { count: "exact", head: true })
          .eq("product_id", productId);

        await supabase.from("product_images").insert({
          product_id: productId,
          url,
          filename: file.name,
          is_primary: (count ?? 0) === 0,
          sort_order: count ?? 0,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  }

  return (
    <div className="card space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-ink">Upload Images</h3>
        <p className="text-xs text-muted">
          Stored in Supabase Storage (bucket <code>{BUCKET}</code>) and linked to <code>product_images</code> when a product is selected.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Attach to product (optional)</label>
          <select className="input" value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">— Don’t link, just upload —</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>{p.name_en ?? p.id}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Image file</label>
          <input type="file" accept="image/*" onChange={onUpload} disabled={busy} className="block text-sm" />
        </div>
      </div>

      {busy ? <p className="text-sm text-muted">Uploading…</p> : null}
      {error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p> : null}
      {uploadedUrl ? (
        <div className="flex items-center gap-3 rounded-lg bg-green-50 px-3 py-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={uploadedUrl} alt="uploaded" className="h-12 w-12 rounded object-cover" />
          <a href={uploadedUrl} target="_blank" rel="noreferrer" className="break-all text-xs text-green-700 underline">
            {uploadedUrl}
          </a>
        </div>
      ) : null}
    </div>
  );
}
