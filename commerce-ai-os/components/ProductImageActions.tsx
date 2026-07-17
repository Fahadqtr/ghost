"use client";

import { useState } from "react";

// Copy / download the product image. Both go through the same-origin proxy
// (/api/products/image) so cross-origin CDN images work without CORS issues.
export default function ProductImageActions({ url, name }: { url: string; name?: string | null }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const flash = (t: string) => { setMsg(t); setTimeout(() => setMsg(""), 1800); };

  const proxy = (dl: boolean) =>
    `/api/products/image?url=${encodeURIComponent(url)}${dl ? "&dl=1" : ""}&name=${encodeURIComponent(name || "product")}`;

  const download = () => {
    const a = document.createElement("a");
    a.href = proxy(true);
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const copy = async () => {
    setBusy(true);
    try {
      const res = await fetch(proxy(false));
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      // Clipboard image write is reliable as PNG — normalise via a canvas.
      const png = await toPng(blob);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      flash("نُسخت الصورة ✓");
    } catch {
      flash("تعذّر النسخ — استخدم التنزيل");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={download} className="btn-ghost px-3 py-1.5 text-xs">⬇️ تنزيل الصورة</button>
      <button type="button" onClick={copy} disabled={busy} className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-50">
        {busy ? "…ينسخ" : "📋 نسخ الصورة"}
      </button>
      {msg ? <span className="text-xs text-muted">{msg}</span> : null}
    </div>
  );
}

// Decode any image blob and re-encode as PNG so clipboard.write always succeeds.
function toPng(blob: Blob): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objUrl = URL.createObjectURL(blob);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) { URL.revokeObjectURL(objUrl); reject(new Error("no ctx")); return; }
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((out) => { URL.revokeObjectURL(objUrl); if (out) resolve(out); else reject(new Error("no blob")); }, "image/png");
    };
    img.onerror = () => { URL.revokeObjectURL(objUrl); reject(new Error("img load")); };
    img.src = objUrl;
  });
}
