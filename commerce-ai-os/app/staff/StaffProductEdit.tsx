"use client";

import { useEffect, useState, useTransition } from "react";
import { staffProductForEdit, staffUpdateProduct, staffUploadProductImage, type StaffEditable } from "./actions";
import { CATEGORIES } from "@/lib/constants";
import { type Locale } from "@/lib/i18n";

// Supervisor edit sheet on /staff — price, names, descriptions, category and
// (with edit_images) the primary photo. Every save flows through the same
// server rules as the manager's editor and opens the catalog auto-task.

export type StaffProductPatchUI = {
  name?: string | null; nameAr?: string | null; category?: string | null;
  price?: number | null; image?: string | null;
};

export default function StaffProductEdit({ productId, locale, onClose, onSaved }: {
  productId: string;
  locale: Locale;
  onClose: () => void;
  onSaved: (id: string, patch: StaffProductPatchUI) => void;
}) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [item, setItem] = useState<StaffEditable | null>(null);
  const [err, setErr] = useState("");
  const [savedFlash, setSavedFlash] = useState("");
  const [busy, start] = useTransition();

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await staffProductForEdit(productId);
      if (!alive) return;
      if ("error" in r) { setErr(r.error); return; }
      setItem(r.item);
    })();
    return () => { alive = false; };
  }, [productId]);

  const set = (k: keyof StaffEditable, v: string) => setItem((it) => (it ? { ...it, [k]: v } : it));

  const save = () => {
    if (!item) return;
    setErr("");
    start(async () => {
      const r = await staffUpdateProduct(item.id, {
        name_en: item.name_en, name_ar: item.name_ar,
        price: item.price, discount_price: item.discount_price,
        main_category: item.main_category,
        description_en: item.description_en, description_ar: item.description_ar,
      });
      if ("error" in r) { setErr(r.error); return; }
      const disc = item.discount_price.trim() === "" ? null : Number(item.discount_price);
      const price = item.price.trim() === "" ? null : Number(item.price);
      onSaved(item.id, {
        name: item.name_en.trim() || item.name_ar.trim() || null,
        nameAr: item.name_ar.trim() || null,
        category: item.main_category.trim() || null,
        price: disc ?? price,
      });
      onClose();
    });
  };

  const onFile = (file: File) => {
    if (!item) return;
    setErr("");
    start(async () => {
      try {
        const fd = new FormData();
        fd.set("productId", item.id);
        fd.set("file", file);
        const r = await staffUploadProductImage(fd);
        if ("error" in r) { setErr(r.error); return; }
        setItem((it) => (it ? { ...it, image_url: r.url } : it));
        onSaved(item.id, { image: r.url });
        setSavedFlash(L("✓ انرفعت الصورة وصارت الأساسية", "✓ Photo uploaded & set as primary"));
        setTimeout(() => setSavedFlash(""), 2500);
      } catch {
        setErr(L("تعذّر رفع الصورة — جرّب صورة أصغر.", "Couldn't upload — try a smaller photo."));
      }
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-4 shadow-xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <p className="text-base font-bold text-ink">✏️ {L("تعديل المنتج", "Edit product")}{item?.sku ? <span className="ms-2 font-mono text-xs font-normal text-muted">{item.sku}</span> : null}</p>
          <button onClick={onClose} className="rounded-full bg-slate-100 px-3 py-1 text-sm font-bold text-slate-700">✕</button>
        </div>

        {err ? <div className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div> : null}
        {savedFlash ? <div className="mb-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{savedFlash}</div> : null}
        {!item && !err ? <p className="py-8 text-center text-sm text-slate-400">{L("جاري التحميل…", "Loading…")}</p> : null}

        {item ? (
          <div className="space-y-2.5">
            {/* photo */}
            <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-2.5">
              {item.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.image_url} alt="" className="h-16 w-16 rounded-lg border border-slate-200 bg-white object-cover" />
              ) : (
                <span className="flex h-16 w-16 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white text-2xl text-slate-300">📦</span>
              )}
              {item.canEditImage ? (
                <label className="cursor-pointer rounded-lg border border-violet-200 bg-white px-3 py-2 text-xs font-medium text-violet-700">
                  🖼️ {L("بدّل الصورة", "Replace photo")}
                  <input type="file" accept="image/*" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
                </label>
              ) : (
                <span className="text-[11px] text-muted">{L("ما عندك صلاحية تغيير الصورة.", "No photo-edit permission.")}</span>
              )}
              {busy ? <span className="text-xs text-violet-600">…</span> : null}
            </div>

            {item.canEdit ? (
              <>
                <label className="block text-xs font-medium text-muted">{L("الاسم (عربي)", "Name (AR)")}
                  <input className="input mt-1 w-full" dir="rtl" value={item.name_ar} onChange={(e) => set("name_ar", e.target.value)} />
                </label>
                <label className="block text-xs font-medium text-muted">{L("الاسم (إنجليزي)", "Name (EN)")}
                  <input className="input mt-1 w-full" dir="ltr" value={item.name_en} onChange={(e) => set("name_en", e.target.value)} />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block text-xs font-medium text-muted">{L("السعر (ر.ق)", "Price (QAR)")}
                    <input className="input mt-1 w-full" inputMode="decimal" value={item.price} onChange={(e) => set("price", e.target.value)} />
                  </label>
                  <label className="block text-xs font-medium text-muted">{L("السعر بعد الخصم", "Discounted price")}
                    <input className="input mt-1 w-full" inputMode="decimal" value={item.discount_price} onChange={(e) => set("discount_price", e.target.value)} placeholder={L("فاضي = بدون خصم", "empty = none")} />
                  </label>
                </div>
                <label className="block text-xs font-medium text-muted">{L("الفئة", "Category")}
                  <select className="input mt-1 w-full" value={item.main_category} onChange={(e) => set("main_category", e.target.value)}>
                    <option value="">{L("— بدون —", "— none —")}</option>
                    {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
                <label className="block text-xs font-medium text-muted">{L("الوصف (عربي)", "Description (AR)")}
                  <textarea className="input mt-1 w-full" rows={3} dir="rtl" value={item.description_ar} onChange={(e) => set("description_ar", e.target.value)} />
                </label>
                <label className="block text-xs font-medium text-muted">{L("الوصف (إنجليزي)", "Description (EN)")}
                  <textarea className="input mt-1 w-full" rows={3} dir="ltr" value={item.description_en} onChange={(e) => set("description_en", e.target.value)} />
                </label>
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                  💡 {L("كل تعديل يفتح مهمة تلقائيًا لتحديث المنصات اليدوية (سنونو مليكاز / سنونو بيور سيول / رفيق) — شوبي فاي يتزامن بروحه.", "Every save auto-opens a task to update the manual platforms — Shopify syncs itself.")}
                </p>
                <button disabled={busy} onClick={save} className="btn-primary w-full py-3 text-base disabled:opacity-50">
                  {busy ? "..." : L("💾 احفظ التعديلات", "💾 Save changes")}
                </button>
              </>
            ) : (
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-muted">{L("عندك صلاحية تغيير الصورة فقط.", "You can only change the photo.")}</p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
