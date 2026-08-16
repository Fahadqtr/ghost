"use client";

// OPS.2 — Media Center operator surface. Orchestration only: it never writes and
// holds no DB client. Snoonu recovery is a read-only Scan → writer-gated Recover
// that DELEGATES to the CH.6B orchestrator via server actions; manual upload /
// gallery management reuse the existing per-product media editor (deep link to
// catalog edit). Duplicate detection is a read-only report — nothing is ever
// auto-deleted.

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  scanSnoonuImageRecoveryAction,
  recoverSnoonuImagesAction,
} from "@/app/(v2)/v2/operations/media-actions";
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
import type { MissingImageScanResult } from "@/lib/adapters/snoonu/merchant/missing-image-scan";
import type { ApplyItemResult } from "@/lib/adapters/snoonu/merchant/merchant-contract";

type ProductRow = MediaProductRow & { isDuplicate: boolean; healthScore: number };
type Msg = { ok: boolean; text: string } | null;

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
const SNOONU_STOREFRONTS = [
  { key: "snoonu:malikas", label: "Snoonu — Malikas" },
  { key: "snoonu:pure_seoul", label: "Snoonu — Pure Seoul" },
];

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
  const [storefront, setStorefront] = useState<string>(initialStorefront ?? "snoonu:malikas");
  const [scan, setScan] = useState<MissingImageScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<ApplyItemResult[] | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [isPending, startTransition] = useTransition();

  const dupIds = useMemo(() => duplicateProductIds(duplicates), [duplicates]);
  const rows = useMemo(() => searchRows(applyMediaFilter(products, filter, dupIds), query), [products, filter, dupIds, query]);
  const matchedRows = useMemo(() => (scan?.rows ?? []).filter((r) => r.selectable), [scan]);
  const allMatchedSelected = matchedRows.length > 0 && matchedRows.every((r) => selected.has(r.productId));

  function runScan() {
    setScan(null); setSelected(new Set()); setResults(null); setMsg(null);
    startTransition(async () => {
      const res = await scanSnoonuImageRecoveryAction(storefront);
      if ("error" in res) { setMsg({ ok: false, text: res.error }); return; }
      setScan(res);
      setSelected(new Set(res.rows.filter((r) => r.selectable).map((r) => r.productId)));
      if (res.summary.sessionRequired > 0 && res.summary.matched === 0) {
        setMsg({ ok: true, text: "لا توجد جلسة تاجر سنونو مفعّلة — لا مرشّحات استرجاع حتمية الآن (آمن)." });
      }
    });
  }

  function toggle(id: string) {
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  function recover(ids: string[]) {
    if (!canWrite || ids.length === 0) return;
    setResults(null); setMsg(null);
    startTransition(async () => {
      const res = await recoverSnoonuImagesAction(storefront, ids);
      if ("error" in res) { setMsg({ ok: false, text: res.error }); return; }
      setResults(res.results);
      const imported = res.results.filter((r) => r.status === "IMPORTED").length;
      setMsg({ ok: true, text: `تم الاسترجاع: ${imported} صورة. حدّث الصفحة لرؤية النتيجة.` });
    });
  }

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

      {msg && (
        <div className={`card text-sm ${msg.ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}`} role={msg.ok ? "status" : "alert"}>
          {msg.text}
        </div>
      )}

      {/* Snoonu recovery (reuses CH.6B) */}
      <section className="card space-y-2">
        <h2 className="text-sm font-bold text-slate-700">استرجاع الصور من سنونو</h2>
        <div className="flex flex-wrap items-center gap-2">
          <select value={storefront} onChange={(e) => setStorefront(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1 text-xs">
            {SNOONU_STOREFRONTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          <button type="button" onClick={runScan} disabled={isPending} className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            {isPending ? "…" : "فحص (معاينة)"}
          </button>
          {scan && (
            <span className="text-xs text-muted">
              مطابق {scan.summary.matched} · مراجعة {scan.summary.needsReview} · غير موجود {scan.summary.notFound} · بحاجة جلسة {scan.summary.sessionRequired}
            </span>
          )}
        </div>

        {scan && matchedRows.length > 0 && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <span className="text-xs text-muted">محدد {selected.size} / {matchedRows.length} حتمي</span>
              <button type="button" onClick={() => setSelected(allMatchedSelected ? new Set() : new Set(matchedRows.map((r) => r.productId)))} className="rounded-lg border border-slate-200 px-2 py-1 text-xs hover:bg-white">تحديد الكل</button>
              <button
                type="button"
                onClick={() => recover([...selected])}
                disabled={!canWrite || isPending || selected.size === 0}
                title={canWrite ? undefined : "للقراءة فقط"}
                className="rounded-lg bg-slate-800 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
              >
                {canWrite ? "استرجاع المحدد" : "🔒 استرجاع المحدد"}
              </button>
              <button
                type="button"
                onClick={() => recover(matchedRows.map((r) => r.productId))}
                disabled={!canWrite || isPending}
                className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700 disabled:opacity-50"
              >
                استرجاع كل المؤهّل
              </button>
            </div>
            <div className="space-y-1">
              {matchedRows.slice(0, 300).map((r) => (
                <label key={r.productId} className="flex items-center gap-2 rounded-lg border border-slate-100 bg-white px-3 py-1.5 text-xs">
                  <input type="checkbox" disabled={!canWrite} checked={selected.has(r.productId)} onChange={() => toggle(r.productId)} />
                  <span className="font-medium text-slate-700">{r.sku}</span>
                  <span className="text-emerald-600">مطابق (SPI {r.spi})</span>
                  <span className="ms-auto text-muted">{r.reason}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {results && (
          <div className="text-xs text-muted">
            النتائج: مسترجع {results.filter((r) => r.status === "IMPORTED").length} · متجاوَز {results.filter((r) => r.status === "SKIPPED").length} · مراجعة {results.filter((r) => r.status === "NEEDS_REVIEW").length} · فشل {results.filter((r) => r.status === "FAILED").length}
          </div>
        )}
      </section>

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
