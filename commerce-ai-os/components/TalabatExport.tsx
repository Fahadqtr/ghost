"use client";

import { useMemo, useState } from "react";
import type { Locale } from "@/lib/i18n";

export interface CatCount { name: string; count: number }

// Talabat CSV export with a category picker: tick the categories to include,
// then download. No selection params → the route returns all categories.
export default function TalabatExport({ categories, newCount = 0, locale = "ar" }: { categories: CatCount[]; newCount?: number; locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [sel, setSel] = useState<Set<string>>(() => new Set(categories.map((c) => c.name)));

  const total = categories.length;
  const allOn = sel.size === total;
  const noneOn = sel.size === 0;

  const selectedProducts = useMemo(
    () => categories.filter((c) => sel.has(c.name)).reduce((a, c) => a + c.count, 0),
    [categories, sel]
  );

  const toggle = (name: string) =>
    setSel((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });

  const href = allOn
    ? "/api/export/talabat"
    : `/api/export/talabat?cats=${encodeURIComponent([...sel].join("|"))}`;

  return (
    <div className="card space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-ink">{L("تصدير طلبات — اختر الأقسام", "Talabat export — choose categories")}</h3>
        <p className="text-xs text-muted">
          {L(
            "اختر الأقسام التي تريد تصديرها لطلبات، ثم نزّل ملف الـCSV. الكل محدد افتراضيًا.",
            "Pick the categories you want to export to Talabat, then download the CSV file. All selected by default."
          )}
        </p>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <button type="button" onClick={() => setSel(new Set(categories.map((c) => c.name)))} className="btn-ghost px-2 py-1">
          {L("تحديد الكل", "Select all")}
        </button>
        <button type="button" onClick={() => setSel(new Set())} className="btn-ghost px-2 py-1">
          {L("إلغاء الكل", "Clear all")}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {categories.map((c) => (
          <label key={c.name} className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">
            <input
              type="checkbox"
              checked={sel.has(c.name)}
              onChange={() => toggle(c.name)}
              className="h-4 w-4"
            />
            <span className="flex-1 text-ink">{c.name}</span>
            <span className="text-xs text-muted">{c.count}</span>
          </label>
        ))}
      </div>

      <div className="flex flex-col gap-2 border-t border-slate-100 pt-3 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-xs text-muted">
          {noneOn
            ? L("اختر قسمًا واحدًا على الأقل.", "Pick at least one category.")
            : L(`${sel.size} من ${total} قسم · ~${selectedProducts} منتج`, `${sel.size} of ${total} categories · ~${selectedProducts} products`)}
        </span>
        {noneOn ? (
          <span className="btn-primary pointer-events-none opacity-50">⬇ {L("تنزيل CSV", "Download CSV")}</span>
        ) : (
          <a href={href} download className="btn-primary inline-flex">
            ⬇ {L("تنزيل CSV", "Download CSV")} ({allOn ? L("كل الأقسام", "all categories") : L(`${sel.size} أقسام`, `${sel.size} categories`)})
          </a>
        )}
      </div>

      {/* Dedicated export for products added via Snoonu Sync (cleaned, with the
          images that were uploaded). */}
      <div className="border-t border-slate-100 pt-3">
        <h3 className="text-sm font-semibold text-ink">{L("المنتجات الجديدة (من سنونو)", "New products (from Snoonu)")}</h3>
        <p className="text-xs text-muted">
          {L(
            "إكسل طلبات يحتوي فقط المنتجات اللي أضفتها من Snoonu Sync — منظّفة ومعها الصور اللي رفعتها لها.",
            "A Talabat Excel containing only the products you added via Snoonu Sync — cleaned, with the images you uploaded for them."
          )}
        </p>
        {newCount > 0 ? (
          <a href="/api/export/talabat?source=new" download className="btn-primary mt-2 inline-flex">
            ⬇ {L(`تصدير المنتجات الجديدة فقط (${newCount})`, `Export new products only (${newCount})`)}
          </a>
        ) : (
          <p className="mt-2 text-xs text-muted">{L("لا توجد منتجات جديدة بعد — أضفها من تبويب Snoonu Sync أولًا.", "No new products yet — add them from the Snoonu Sync tab first.")}</p>
        )}
      </div>
    </div>
  );
}
