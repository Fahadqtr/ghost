"use client";

import { useState } from "react";

// Structured card body for catalog-change tasks — shared by the manager
// (/tasks) and employee (/staff) views. Platform dashboards are filled field
// by field, so EVERY value gets its own one-tap copy button (name alone,
// price alone, description alone…), plus a copy-all fallback.

export interface CatalogTaskPayload {
  action?: string;
  snapshot?: Record<string, unknown>;
  changes?: { field: string; old: string; new: string }[];
  variantId?: string;   // option-scoped task (one variant only)
  variantName?: string;
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
  oos: { icon: "🚫", label: "نفد المخزون — علّمه غير متوفر", cls: "bg-red-50 text-red-700" },
  restock: { icon: "🔄", label: "رجع المخزون — فعّله", cls: "bg-emerald-50 text-emerald-700" },
  new_product: { icon: "📸", label: "أضِفه كمنتج جديد", cls: "bg-violet-50 text-violet-700" },
};

const s = (v: unknown) => String(v ?? "").trim();

export default function CatalogTaskDetails({ payload, productId, manager = false }: {
  payload: CatalogTaskPayload;
  productId?: string | null;
  manager?: boolean; // adds the open-product link (staff portal has no catalog access)
}) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const snap = payload.snapshot ?? {};
  const action = ACTION_META[payload.action ?? "update"] ?? ACTION_META.update;
  const img = s(snap.image_url);
  const price = Number(snap.price) > 0 ? Number(snap.price) : null;
  const disc = Number(snap.discount_price) > 0 ? Number(snap.discount_price) : null;

  const copy = (key: string, value: string) => {
    navigator.clipboard?.writeText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 2000);
  };

  // Each platform form field maps to one row here — copied alone, on its own.
  const fields: { key: string; label: string; value: string; dir?: "ltr" | "rtl"; long?: boolean }[] = [
    { key: "name_en", label: "الاسم EN", value: s(snap.name_en), dir: "ltr" as const },
    { key: "name_ar", label: "الاسم AR", value: s(snap.name_ar), dir: "rtl" as const },
    { key: "sku", label: "SKU", value: s(snap.sku), dir: "ltr" as const },
    { key: "barcode", label: "الباركود", value: s(snap.barcode), dir: "ltr" as const },
    { key: "price", label: "السعر", value: price != null ? String(price) : "" },
    { key: "discount_price", label: "السعر بعد الخصم", value: disc != null ? String(disc) : "" },
    { key: "main_category", label: "التصنيف", value: s(snap.main_category) },
    { key: "description_en", label: "الوصف EN", value: s(snap.description_en), dir: "ltr" as const, long: true },
    { key: "description_ar", label: "الوصف AR", value: s(snap.description_ar), dir: "rtl" as const, long: true },
  ].filter((f) => f.value);

  const copyAll = () => {
    copy("__all", fields.map((f) => `${f.label}: ${f.value}`).join("\n"));
  };

  return (
    <div className="mt-2 space-y-2.5 rounded-xl border border-[#efe3d6] bg-[#fdfaf5] p-3">
      {/* Photo + action badge */}
      <div className="flex items-start gap-3">
        {img ? (
          <a href={img} target="_blank" rel="noreferrer" className="shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img} alt="" loading="lazy" className="h-20 w-20 rounded-xl border border-[#efe3d6] bg-white object-cover" />
          </a>
        ) : (
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white text-[10px] text-slate-400">بدون صورة</div>
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-bold ${action.cls}`}>{action.icon} {action.label}</span>
          {payload.variantName ? (
            <span className="ms-1 inline-block rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-bold text-violet-700">🎚️ الخيار: {payload.variantName} فقط</span>
          ) : null}
          {disc != null && price != null && disc < price ? (
            <p className="text-sm"><b className="text-emerald-700">{disc} ر.ق</b> <s className="text-xs text-muted">{price} ر.ق</s></p>
          ) : price != null || disc != null ? (
            <p className="text-sm"><b className="text-ink">{disc ?? price} ر.ق</b></p>
          ) : null}
          {img ? (
            <a href={img} target="_blank" rel="noreferrer" className="inline-block rounded-lg border border-[#e5d5c0] bg-white px-2.5 py-1 text-[11px] font-medium text-ink">
              ⬇️ نزّل الصورة
            </a>
          ) : null}
        </div>
      </div>

      {/* Old → new changes */}
      {payload.changes?.length ? (
        <div className="space-y-1 rounded-lg bg-amber-50 p-2.5 ring-1 ring-amber-200">
          <p className="text-[11px] font-bold text-amber-800">التغييرات المطلوب نقلها للمنصات:</p>
          {payload.changes.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <p className="min-w-0 flex-1 text-xs text-amber-900">
                <b>{FIELD_AR[c.field] ?? c.field}:</b> <s className="opacity-60">{c.old}</s> ← <b>{c.new}</b>
              </p>
              <button type="button" onClick={() => copy(`chg-${i}`, c.new)} className="shrink-0 rounded-md bg-white px-2 py-0.5 text-[10px] font-bold text-amber-800 ring-1 ring-amber-300">
                {copiedKey === `chg-${i}` ? "✅" : "📋 انسخ الجديد"}
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {payload.action === "delete" ? (
        <p className="rounded-lg bg-red-50 px-2.5 py-2 text-xs font-bold text-red-700 ring-1 ring-red-200">
          ⚠️ هذا المنتج انحذف من الكتالوج — احذفه من لوحات المنصات اليدوية أيضًا.
        </p>
      ) : null}

      {/* One row per platform-form field, each with its own copy button */}
      <div className="divide-y divide-[#f3e9db] rounded-lg bg-white ring-1 ring-[#efe3d6]">
        {fields.map((f) => (
          <div key={f.key} className="flex items-center gap-2 px-2.5 py-1.5">
            <span className="w-24 shrink-0 text-[10px] font-bold text-muted">{f.label}</span>
            {f.long ? (
              <details className="min-w-0 flex-1">
                <summary className="cursor-pointer truncate text-xs text-ink/80" dir={f.dir}>{f.value.slice(0, 60)}{f.value.length > 60 ? "…" : ""}</summary>
                <p className="mt-1 whitespace-pre-line text-xs text-muted" dir={f.dir}>{f.value}</p>
              </details>
            ) : (
              <span className="min-w-0 flex-1 truncate text-xs text-ink" dir={f.dir}>{f.value}</span>
            )}
            <button
              type="button"
              onClick={() => copy(f.key, f.value)}
              className={`shrink-0 rounded-md px-2 py-1 text-[10px] font-bold ring-1 ${copiedKey === f.key ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-[#faf6f0] text-ink ring-[#e5d5c0]"}`}
            >
              {copiedKey === f.key ? "✅ انتسخ" : "📋"}
            </button>
          </div>
        ))}
      </div>

      {/* Where the manual update goes (a photo-task isn't in the catalog yet) */}
      {payload.action !== "bulk" && payload.action !== "new_product" ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="font-semibold text-ink">📌 حدّث يدويًا في:</span>
          {["طلبات", "سنونو", "رفيق"].map((p) => (
            <span key={p} className="rounded-full bg-white px-2 py-0.5 text-muted ring-1 ring-[#efe3d6]">☐ {p}</span>
          ))}
          <span className="text-muted">(شوبي فاي تلقائي ✓)</span>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={copyAll} className="rounded-lg bg-ink px-3 py-1.5 text-[11px] font-bold text-white">
          {copiedKey === "__all" ? "✅ انتسخ الكل" : "📋 نسخ الكل دفعة وحدة"}
        </button>
        {manager && productId && payload.action !== "delete" ? (
          <a href={`/products/${productId}`} target="_blank" rel="noreferrer" className="rounded-lg border border-[#e5d5c0] bg-white px-3 py-1.5 text-[11px] font-medium text-ink">
            ✏️ فتح المنتج
          </a>
        ) : null}
      </div>
    </div>
  );
}
