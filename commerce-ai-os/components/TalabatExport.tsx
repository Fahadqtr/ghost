"use client";

import { useMemo, useState } from "react";

export interface CatCount { name: string; count: number }

// Talabat CSV export with a category picker: tick the categories to include,
// then download. No selection params → the route returns all categories.
export default function TalabatExport({ categories }: { categories: CatCount[] }) {
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
        <h3 className="text-sm font-semibold text-ink">Talabat export — choose categories</h3>
        <p className="text-xs text-muted">
          اختر الأقسام التي تريد تصديرها لطلبات، ثم نزّل ملف الـCSV. الكل محدد افتراضيًا.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <button type="button" onClick={() => setSel(new Set(categories.map((c) => c.name)))} className="btn-ghost px-2 py-1">
          تحديد الكل
        </button>
        <button type="button" onClick={() => setSel(new Set())} className="btn-ghost px-2 py-1">
          إلغاء الكل
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
            ? "اختر قسمًا واحدًا على الأقل."
            : `${sel.size} من ${total} قسم · ~${selectedProducts} منتج`}
        </span>
        {noneOn ? (
          <span className="btn-primary pointer-events-none opacity-50">⬇ تنزيل CSV</span>
        ) : (
          <a href={href} download className="btn-primary inline-flex">
            ⬇ تنزيل CSV ({allOn ? "كل الأقسام" : `${sel.size} أقسام`})
          </a>
        )}
      </div>
    </div>
  );
}
