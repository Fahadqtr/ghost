"use client";

// OPS.2 — Media Center operator surface. Orchestration only: it never writes and
// holds no DB client. Snoonu recovery is the MEDIA.2 bulk workspace
// (SnoonuBulkRecovery), which delegates every write to the certified MEDIA.1C
// pipeline via server actions; manual upload / gallery management reuse the
// existing per-product media editor (deep link to catalog edit). Duplicate
// detection is a read-only report — nothing is ever auto-deleted.

import { useMemo, useState } from "react";
import Link from "next/link";
import SnoonuBulkRecovery from "@/components/v2/operations/SnoonuBulkRecovery";
import {
  mediaHealthTone,
  applyMediaFilter,
  searchRows,
  duplicateProductIds,
  type MediaDashboard,
  type DuplicateGroup,
  type MissingImageItem,
  type MediaProductRow,
  type MediaFilter,
  type CardTone,
} from "@/lib/operations/media/media-core";

type ProductRow = MediaProductRow & { isDuplicate: boolean; healthScore: number };

const CARD_TONE: Record<CardTone, string> = {
  neutral: "border-slate-200 bg-white text-slate-700",
  good: "border-emerald-200 bg-emerald-50 text-emerald-700",
  warn: "border-amber-200 bg-amber-50 text-amber-700",
  bad: "border-rose-200 bg-rose-50 text-rose-700",
};
const HEALTH_TONE: Record<string, string> = {
  good: "bg-emerald-100 text-emerald-700",
  warn: "bg-amber-100 text-amber-700",
  bad: "bg-rose-100 text-rose-700",
};
const DUP_LABEL: Record<string, string> = {
  cross_product_url: "رابط مكرر عبر منتجات",
  cross_product_filename: "اسم ملف مكرر عبر منتجات",
  same_product_url: "رابط مكرر داخل المنتج",
};

export default function MediaCenter({
  canWrite,
  dashboard,
  products,
  missing,
  duplicates,
  degraded,
  initialStorefront,
}: {
  canWrite: boolean;
  dashboard: MediaDashboard;
  products: ProductRow[];
  missing: MissingImageItem[];
  duplicates: DuplicateGroup[];
  degraded: boolean;
  // OPS.4 deep-link seed (validated server-side; Snoonu recovery storefront).
  initialStorefront?: string;
}) {
  const [filter, setFilter] = useState<MediaFilter>("all");
  const [query, setQuery] = useState("");

  const dupIds = useMemo(() => duplicateProductIds(duplicates), [duplicates]);
  const rows = useMemo(() => searchRows(applyMediaFilter(products, filter, dupIds), query), [products, filter, dupIds, query]);

  return (
    <div className="space-y-4">
      {/* dashboard cards */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {dashboard.cards.map((c) => (
          <Link key={c.key} href={c.href} className={`rounded-xl border px-3 py-2 text-center transition hover:brightness-95 ${CARD_TONE[c.tone]}`}>
            <div className="text-lg font-bold">{c.value === null ? "↗" : c.value}</div>
            <div className="text-[11px] font-medium opacity-80">{c.label}</div>
            {c.note && <div className="text-[9px] opacity-60">{c.note}</div>}
          </Link>
        ))}
      </div>
      <div className="text-[11px] text-muted">متوسط صحة الوسائط: {dashboard.totals.averageHealth}%{degraded ? " · بيانات منقوصة (تعذّرت قراءة جزء)" : ""}</div>

      {/* Snoonu bulk recovery (MEDIA.2) — delegates every write to MEDIA.1C */}
      <SnoonuBulkRecovery canWrite={canWrite} initialStorefront={initialStorefront} />

      {/* Missing images queue */}
      {missing.length > 0 && (
        <section className="card space-y-2">
          <h2 className="text-sm font-bold text-slate-700">قائمة الصور الناقصة ({missing.length})</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-400">
                  <th className="px-2 py-1 text-start font-medium">SKU</th>
                  <th className="px-2 py-1 text-start font-medium">المنتج</th>
                  <th className="px-2 py-1 text-start font-medium">الفئة</th>
                  <th className="px-2 py-1 text-center font-medium">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {missing.slice(0, 200).map((it) => (
                  <tr key={it.productId} className="border-t border-slate-100">
                    <td className="px-2 py-1.5 font-medium text-slate-700">{it.sku}</td>
                    <td className="px-2 py-1.5 text-slate-600">{it.name ?? "—"}</td>
                    <td className="px-2 py-1.5 text-muted">{it.category ?? "—"}</td>
                    <td className="px-2 py-1.5 text-center">
                      <Link href={`/v2/catalog/${it.productId}/edit`} className="rounded border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50">رفع يدوي ↗</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {missing.length > 200 && <div className="text-center text-[11px] text-muted">عرض أول 200 من {missing.length}</div>}
          </div>
        </section>
      )}

      {/* Duplicate report (read-only; never auto-deletes) */}
      {duplicates.length > 0 && (
        <section className="card space-y-2">
          <h2 className="text-sm font-bold text-slate-700">الصور المكررة ({duplicates.length}) — تقرير للقراءة فقط</h2>
          <ul className="space-y-1 text-xs">
            {duplicates.slice(0, 100).map((g, i) => (
              <li key={`${g.kind}:${g.value}:${i}`} className="rounded-lg border border-amber-100 bg-amber-50 px-2.5 py-1.5 text-amber-800">
                <span className="font-semibold">{DUP_LABEL[g.kind]}</span> · {g.productIds.length} منتج · <span className="opacity-70">{g.value}</span>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted">لا يُحذف أي صورة تلقائيًا — عالِج التكرار يدويًا من محرّر وسائط المنتج.</p>
        </section>
      )}

      {/* Products + media health */}
      <section className="card space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-bold text-slate-700">المنتجات</h2>
          {(["all", "missing", "has_primary", "multiple", "duplicate"] as MediaFilter[]).map((f) => (
            <button key={f} type="button" onClick={() => setFilter(f)} className={`rounded-lg border px-2.5 py-1 text-[11px] font-semibold ${filter === f ? "border-slate-800 bg-slate-800 text-white" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
              {{ all: "الكل", missing: "ناقصة", has_primary: "لها صورة", multiple: "متعددة", duplicate: "مكررة" }[f]}
            </button>
          ))}
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="بحث SKU / اسم / براند / فئة" className="ms-auto w-56 rounded-lg border border-slate-200 px-2 py-1 text-xs" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-400">
                <th className="px-2 py-1 text-start font-medium">صورة</th>
                <th className="px-2 py-1 text-start font-medium">SKU</th>
                <th className="px-2 py-1 text-start font-medium">المنتج</th>
                <th className="px-2 py-1 text-center font-medium">المعرض</th>
                <th className="px-2 py-1 text-center font-medium">الصحة</th>
                <th className="px-2 py-1 text-center font-medium">تحرير</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 300).map((r) => (
                <tr key={r.productId} className="border-t border-slate-100">
                  <td className="px-2 py-1.5">
                    {r.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.imageUrl} alt="" className="h-8 w-8 rounded object-cover" loading="lazy" />
                    ) : (
                      <span className="inline-block h-8 w-8 rounded bg-slate-100 text-center text-[9px] leading-8 text-slate-400">لا</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 font-medium text-slate-700">{r.sku}</td>
                  <td className="px-2 py-1.5 text-slate-600">{r.nameAr ?? r.nameEn ?? "—"}{r.isDuplicate && <span className="ms-1 rounded bg-amber-100 px-1 text-[9px] text-amber-700">مكرر</span>}</td>
                  <td className="px-2 py-1.5 text-center">{r.galleryCount}</td>
                  <td className="px-2 py-1.5 text-center"><span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${HEALTH_TONE[mediaHealthTone(r.healthScore)]}`}>{r.healthScore}</span></td>
                  <td className="px-2 py-1.5 text-center"><Link href={`/v2/catalog/${r.productId}/edit`} className="text-slate-500 hover:text-slate-800">↗</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 300 && <div className="text-center text-[11px] text-muted">عرض أول 300 من {rows.length}</div>}
        </div>
      </section>
    </div>
  );
}
