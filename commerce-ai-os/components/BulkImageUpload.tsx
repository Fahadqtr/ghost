"use client";

import { useState } from "react";
import { uploadProductImage } from "@/app/(app)/products/image-actions";
import type { Locale } from "@/lib/i18n";

export interface BulkImageProduct {
  id: string;
  name: string | null;
  sku: string | null;
}

type Status = "idle" | "saving" | "done" | "error";

// Pick an image (from the device) for each selected product, then save them all
// in one pass. Reuses uploadProductImage (stores + sets the product's primary
// image). Products left without a pick are simply skipped.
export default function BulkImageUpload({
  products, locale = "ar", onClose, onSaved,
}: {
  products: BulkImageProduct[];
  locale?: Locale;
  onClose: () => void;
  onSaved: (urls: Record<string, string>) => void;
}) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [files, setFiles] = useState<Record<string, File>>({});
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");

  const pick = (id: string, file: File | undefined) => {
    if (!file) return;
    setPreviews((s) => {
      if (s[id]) URL.revokeObjectURL(s[id]);
      return { ...s, [id]: URL.createObjectURL(file) };
    });
    setFiles((s) => ({ ...s, [id]: file }));
    setStatus((s) => ({ ...s, [id]: "idle" }));
    setErrs((s) => { const n = { ...s }; delete n[id]; return n; });
  };

  const pickedIds = Object.keys(files);

  const saveAll = async () => {
    if (pickedIds.length === 0 || saving) return;
    setSaving(true); setNote("");
    const urls: Record<string, string> = {};
    let done = 0, failed = 0;
    for (const id of pickedIds) {
      if (status[id] === "done") { done++; continue; }
      setStatus((s) => ({ ...s, [id]: "saving" }));
      try {
        const fd = new FormData();
        fd.set("file", files[id]);
        fd.set("productId", id);
        const r: any = await uploadProductImage(fd);
        if (r?.error) throw new Error(r.error);
        const url = String(r?.url || "");
        urls[id] = url;
        setStatus((s) => ({ ...s, [id]: "done" }));
        done++;
      } catch (e: any) {
        setStatus((s) => ({ ...s, [id]: "error" }));
        setErrs((s) => ({ ...s, [id]: e?.message || L("فشل الرفع", "Upload failed") }));
        failed++;
      }
    }
    if (Object.keys(urls).length) onSaved(urls);
    setSaving(false);
    setNote(L(`✅ حُفظت ${done} صورة${failed ? ` · فشل ${failed}` : ""}`, `✅ Saved ${done} image(s)${failed ? ` · ${failed} failed` : ""}`));
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={L("إضافة صور للمحدّد", "Add images to selected")}
      onClick={() => !saving && onClose()}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4">
      <div onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-[#efe3d6] px-4 py-3">
          <div>
            <h2 className="text-sm font-bold text-ink">{L("إضافة صور للمنتجات المحدّدة", "Add images to selected products")}</h2>
            <p className="text-xs text-muted">{L(`${products.length} منتج · اختر صورة لكل واحد ثم احفظ الكل`, `${products.length} products · pick an image for each, then save all`)}</p>
          </div>
          <button type="button" onClick={() => !saving && onClose()} aria-label={L("إغلاق", "Close")}
            className="rounded-full p-1 text-lg leading-none text-slate-500 hover:bg-slate-100">✕</button>
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {products.map((p) => {
            const st = status[p.id] ?? "idle";
            return (
              <div key={p.id} className="flex items-center gap-3 rounded-xl border border-[#efe3d6] bg-white p-2.5">
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-slate-100 ring-1 ring-slate-200">
                  {previews[p.id] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={previews[p.id]} alt="" className="h-full w-full object-cover" />
                  ) : <div className="flex h-full w-full items-center justify-center text-2xl text-slate-300">📦</div>}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink">{p.name || p.sku || "—"}</p>
                  {p.sku ? <p className="truncate text-[11px] text-muted">SKU {p.sku}</p> : null}
                  {st === "done" ? <p className="text-[11px] font-semibold text-emerald-600">{L("✓ محفوظة", "✓ Saved")}</p> : null}
                  {st === "error" ? <p className="text-[11px] font-semibold text-red-600">{errs[p.id]}</p> : null}
                </div>
                <label className={`shrink-0 cursor-pointer rounded-full px-3 py-1.5 text-xs font-bold ${previews[p.id] ? "bg-slate-100 text-slate-700" : "bg-brand text-white"} ${saving ? "opacity-50" : ""}`}>
                  {st === "saving" ? "⏳" : previews[p.id] ? L("📷 غيّر", "📷 Change") : L("📷 اختر صورة", "📷 Pick image")}
                  <input type="file" accept="image/*" className="hidden" disabled={saving}
                    aria-label={L(`صورة ${p.name || p.sku || ""}`, `Image for ${p.name || p.sku || ""}`)}
                    onChange={(e) => { pick(p.id, e.target.files?.[0]); e.currentTarget.value = ""; }} />
                </label>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-[#efe3d6] bg-slate-50 px-4 py-3">
          <span className="text-xs text-muted">{note || L(`${pickedIds.length} صورة جاهزة`, `${pickedIds.length} image(s) ready`)}</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => !saving && onClose()} className="btn-ghost px-4 py-2 text-sm">{L("إغلاق", "Close")}</button>
            <button type="button" onClick={saveAll} disabled={saving || pickedIds.length === 0}
              className="btn-primary px-5 py-2 text-sm disabled:opacity-50">
              {saving ? L("جارٍ الحفظ…", "Saving…") : L(`💾 احفظ الكل (${pickedIds.length})`, `💾 Save all (${pickedIds.length})`)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
