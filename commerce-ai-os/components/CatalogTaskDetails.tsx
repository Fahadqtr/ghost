"use client";

import { useState } from "react";

// Structured card body for catalog-change tasks — shared by the manager
// (/tasks) and employee (/staff) views. Renders the product snapshot stored in
// the task payload: photo, ordered fields, old→new changes, the manual
// platforms checklist, and one-tap copy/download. Replaces the raw text wall.

export interface CatalogTaskPayload {
  action?: string;
  snapshot?: Record<string, unknown>;
  changes?: { field: string; old: string; new: string }[];
}

const FIELD_AR: Record<string, string> = {
  name_en: "الاسم EN", name_ar: "الاسم AR", price: "السعر", discount_price: "الخصم",
  description_en: "الوصف EN", description_ar: "الوصف AR", sku: "SKU", barcode: "الباركود",
  main_category: "التصنيف", sub_category: "التصنيف الفرعي", image_url: "الصورة", approval: "الحالة",
};

const ACTION_META: Record<string, { icon: string; label: string; cls: string }> = {
  create: { icon: "🆕", label: "منتج جديد", cls: "bg-emerald-50 text-emerald-700" },
  update: { icon: "✏️", label: "تعديل", cls: "bg-sky-50 text-sky-700" },
  delete: { icon: "🗑️", label: "حذف", cls: "bg-red-50 text-red-700" },
  image: { icon: "🖼️", label: "صورة جديدة", cls: "bg-violet-50 text-violet-700" },
  approval: { icon: "🔖", label: "تغيير حالة", cls: "bg-amber-50 text-amber-700" },
  bulk: { icon: "📦", label: "عملية جماعية", cls: "bg-slate-100 text-slate-600" },
};

const s = (v: unknown) => String(v ?? "").trim();

export default function CatalogTaskDetails({ payload, productId, manager = false }: {
  payload: CatalogTaskPayload;
  productId?: string | null;
  manager?: boolean; // adds the open-product link (staff portal has no catalog access)
}) {
  const [copied, setCopied] = useState(false);
  const snap = payload.snapshot ?? {};
  const action = ACTION_META[payload.action ?? "update"] ?? ACTION_META.update;
  const img = s(snap.image_url);
  const price = Number(snap.price) > 0 ? Number(snap.price) : null;
  const disc = Number(snap.discount_price) > 0 ? Number(snap.discount_price) : null;

  const copyData = () => {
    const lines = [
      s(snap.name_en) && `Name EN: ${s(snap.name_en)}`,
      s(snap.name_ar) && `الاسم: ${s(snap.name_ar)}`,
      s(snap.sku) && `SKU: ${s(snap.sku)}`,
      s(snap.barcode) && `Barcode: ${s(snap.barcode)}`,
      price != null ? `Price: ${price} QAR` : "",
      disc != null ? `Discounted: ${disc} QAR` : "",
      s(snap.main_category) && `Category: ${s(snap.main_category)}`,
      s(snap.description_en) && `Description EN:\n${s(snap.description_en)}`,
      s(snap.description_ar) && `الوصف:\n${s(snap.description_ar)}`,
    ].filter(Boolean).join("\n");
    navigator.clipboard?.writeText(lines);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div className="mt-2 space-y-2.5 rounded-xl border border-[#efe3d6] bg-[#fdfaf5] p-3">
      {/* Photo + core identity */}
      <div className="flex items-start gap-3">
        {img ? (
          <a href={img} target="_blank" rel="noreferrer" className="shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img} alt="" loading="lazy" className="h-20 w-20 rounded-xl border border-[#efe3d6] bg-white object-cover" />
          </a>
        ) : (
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white text-[10px] text-slate-400">بدون صورة</div>
        )}
        <div className="min-w-0 flex-1 space-y-0.5">
          <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-bold ${action.cls}`}>{action.icon} {action.label}</span>
          {s(snap.name_ar) ? <p className="text-sm font-bold text-ink">{s(snap.name_ar)}</p> : null}
          {s(snap.name_en) ? <p className="truncate text-xs text-ink/80" dir="ltr">{s(snap.name_en)}</p> : null}
          <div className="flex flex-wrap gap-1 pt-0.5">
            {s(snap.sku) ? <span className="rounded bg-white px-1.5 py-0.5 text-[10px] font-mono text-muted ring-1 ring-[#efe3d6]">{s(snap.sku)}</span> : null}
            {s(snap.barcode) ? <span className="rounded bg-white px-1.5 py-0.5 text-[10px] font-mono text-muted ring-1 ring-[#efe3d6]">{s(snap.barcode)}</span> : null}
            {s(snap.main_category) ? <span className="rounded bg-white px-1.5 py-0.5 text-[10px] text-muted ring-1 ring-[#efe3d6]">{s(snap.main_category)}</span> : null}
          </div>
          {price != null || disc != null ? (
            <p className="pt-0.5 text-sm">
              {disc != null && price != null && disc < price ? (
                <><b className="text-emerald-700">{disc} ر.ق</b> <s className="text-xs text-muted">{price} ر.ق</s></>
              ) : (
                <b className="text-ink">{disc ?? price} ر.ق</b>
              )}
            </p>
          ) : null}
        </div>
      </div>

      {/* Old → new changes */}
      {payload.changes?.length ? (
        <div className="space-y-1 rounded-lg bg-amber-50 p-2.5 ring-1 ring-amber-200">
          <p className="text-[11px] font-bold text-amber-800">التغييرات المطلوب نقلها للمنصات:</p>
          {payload.changes.map((c, i) => (
            <p key={i} className="text-xs text-amber-900">
              <b>{FIELD_AR[c.field] ?? c.field}:</b> <s className="opacity-60">{c.old}</s> ← <b>{c.new}</b>
            </p>
          ))}
        </div>
      ) : null}

      {payload.action === "delete" ? (
        <p className="rounded-lg bg-red-50 px-2.5 py-2 text-xs font-bold text-red-700 ring-1 ring-red-200">
          ⚠️ هذا المنتج انحذف من الكتالوج — احذفه من لوحات المنصات اليدوية أيضًا.
        </p>
      ) : null}

      {/* Long descriptions collapsed out of the way */}
      {s(snap.description_en) || s(snap.description_ar) ? (
        <details className="rounded-lg bg-white p-2 ring-1 ring-[#efe3d6]">
          <summary className="cursor-pointer text-[11px] font-semibold text-ink">📄 الوصف الكامل (للنسخ للمنصات)</summary>
          {s(snap.description_ar) ? <p className="mt-1.5 whitespace-pre-line text-xs text-muted">{s(snap.description_ar)}</p> : null}
          {s(snap.description_en) ? <p className="mt-1.5 whitespace-pre-line text-xs text-muted" dir="ltr">{s(snap.description_en)}</p> : null}
        </details>
      ) : null}

      {/* Where the manual update goes */}
      {payload.action !== "bulk" ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="font-semibold text-ink">📌 حدّث يدويًا في:</span>
          {["طلبات", "سنونو", "رفيق"].map((p) => (
            <span key={p} className="rounded-full bg-white px-2 py-0.5 text-muted ring-1 ring-[#efe3d6]">☐ {p}</span>
          ))}
          <span className="text-muted">(شوبي فاي تلقائي ✓)</span>
        </div>
      ) : null}

      {/* One-tap tools */}
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={copyData} className="rounded-lg bg-ink px-3 py-1.5 text-[11px] font-bold text-white">
          {copied ? "✅ انتسخت" : "📋 نسخ البيانات"}
        </button>
        {img ? (
          <a href={img} target="_blank" rel="noreferrer" className="rounded-lg border border-[#e5d5c0] bg-white px-3 py-1.5 text-[11px] font-medium text-ink">
            ⬇️ الصورة
          </a>
        ) : null}
        {manager && productId && payload.action !== "delete" ? (
          <a href={`/products/${productId}`} target="_blank" rel="noreferrer" className="rounded-lg border border-[#e5d5c0] bg-white px-3 py-1.5 text-[11px] font-medium text-ink">
            ✏️ فتح المنتج
          </a>
        ) : null}
      </div>
    </div>
  );
}
