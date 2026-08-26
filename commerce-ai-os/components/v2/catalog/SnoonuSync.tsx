"use client";

// SNOONU CATALOG SYNC — client surface (owner redesign of تحديث الكتالوج من
// Excel for the Snoonu catalog).
//
//   • upload the Snoonu update workbook → READ-ONLY preview: recognized
//     columns (SPI primary; the store availability column shows as
//     «التوفر في سنونو / حالة التوفر», never غير مستخدم), the exact owner
//     census, and searchable row-level tables for every class (changes / new /
//     REMOVED FROM SNOONU / conflicts / blocked);
//   • nothing writes until the OWNER presses «تطبيق المزامنة» and confirms —
//     apply re-plans server-side and refuses on any drift (fingerprint);
//   • the return/update workbook (SPI + SKU/Barcode/Price on the Snoonu
//     schema) downloads from canonical values — pending sentinels export
//     blank, nothing is invented.

import { useRef, useState } from "react";
import Link from "next/link";
import {
  previewSnoonuSyncAction,
  applySnoonuSyncAction,
  buildSnoonuReturnFileAction,
  previewDuplicatePairAction,
  type SnoonuSyncPreviewVM,
} from "@/app/(v2)/v2/catalog/snoonu-sync/actions";
import type { SnoonuApplyResult } from "@/lib/snoonu/sync.server";
import { SNOONU_MODE_LABEL, SNOONU_MODE_NOTICE, type SnoonuImportMode } from "@/lib/snoonu/sync";
import type { DuplicatePairAudit } from "@/lib/products/duplicate-resolution.server";

const NEW_CLASS_LABEL: Record<string, string> = {
  NEW: "جديد (مكتمل الهوية)",
  NEW_WAITING_SKU: "جديد — بانتظار SKU",
  NEW_WAITING_BARCODE: "جديد — بانتظار الباركود",
  NEW_WAITING_SKU_BARCODE: "جديد — بانتظار SKU والباركود",
};
const FIELD_LABEL: Record<string, string> = {
  name_en: "الاسم (EN)", name_ar: "الاسم (AR)", description_en: "الوصف (EN)", description_ar: "الوصف (AR)",
  price: "السعر", availability: "التوفر", sku: "SKU", barcode: "الباركود",
};

export default function SnoonuSync({ isOwner }: { isOwner: boolean }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | "return" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SnoonuSyncPreviewVM | null>(null);
  const [applied, setApplied] = useState<SnoonuApplyResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [search, setSearch] = useState("");
  // EXPLICIT import mode — never defaulted, never silently switched.
  const [mode, setMode] = useState<SnoonuImportMode | null>(null);
  // PRICE_REVIEW_ZERO — SPIs the owner EXPLICITLY resolved as «اعتماد السعر صفر».
  const [zeroAccepted, setZeroAccepted] = useState<Set<string>>(new Set());
  const [dupAudit, setDupAudit] = useState<DuplicatePairAudit | null>(null);
  const [dupBusy, setDupBusy] = useState(false);

  function formDataWithFile(): FormData | null {
    const file = fileRef.current?.files?.[0];
    if (!file) { setError("اختر ملف Excel أولاً."); return null; }
    const fd = new FormData();
    fd.set("file", file);
    return fd;
  }

  async function runPreview() {
    if (!mode) { setError("اختر وضع الاستيراد أولاً — كامل أو جزئي."); return; }
    const fd = formDataWithFile();
    if (!fd) return;
    fd.set("mode", mode);
    setBusy("preview"); setError(null); setApplied(null); setPreview(null); setConfirming(false);
    setZeroAccepted(new Set()); setDupAudit(null);
    try {
      const res = await previewSnoonuSyncAction(fd);
      if ("error" in res) { setError(res.error); return; }
      setPreview(res.data);
    } catch {
      setError("تعذّرت المعاينة — حاول مرة أخرى.");
    } finally {
      setBusy(null);
    }
  }

  async function runApply() {
    if (!preview || !mode) return;
    const fd = formDataWithFile();
    if (!fd) return;
    fd.set("mode", mode);
    fd.set("fingerprint", preview.plan.fingerprint);
    fd.set("zeroPriceOverrides", JSON.stringify([...zeroAccepted]));
    setBusy("apply"); setError(null);
    try {
      const res = await applySnoonuSyncAction(fd);
      if ("error" in res) { setError(res.error); return; }
      setApplied(res.data);
      setConfirming(false);
    } catch {
      setError("تعذّر التطبيق — لم يكتمل، راجع الحالة ثم أعد المحاولة.");
    } finally {
      setBusy(null);
    }
  }

  async function openDupAudit(skuA: string, skuB: string) {
    setDupBusy(true); setDupAudit(null);
    try {
      const fd = new FormData();
      fd.set("skuA", skuA); fd.set("skuB", skuB);
      const res = await previewDuplicatePairAction(fd);
      if ("error" in res) { setError(res.error); return; }
      setDupAudit(res.data);
    } catch {
      setError("تعذّرت معاينة حل التكرار.");
    } finally {
      setDupBusy(false);
    }
  }

  async function downloadReturnFile() {
    setBusy("return"); setError(null);
    try {
      const res = await buildSnoonuReturnFileAction();
      if ("error" in res) { setError(res.error); return; }
      const bytes = Uint8Array.from(atob(res.data.base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = res.data.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("تعذّر توليد ملف سنونو.");
    } finally {
      setBusy(null);
    }
  }

  const plan = preview?.plan ?? null;
  const q = search.trim().toLowerCase();
  const match = (...vals: (string | null | undefined)[]) => q === "" || vals.some((v) => (v ?? "").toLowerCase().includes(q));
  const filteredMatched = plan ? plan.matched.filter((m) => match(m.spi, m.productSku, m.displayName)) : [];
  const filteredNews = plan ? plan.news.filter((n) => match(n.spi, n.sku, n.nameEn, n.nameAr)) : [];
  const filteredRemovals = plan ? plan.removals.filter((r) => match(r.spi, r.productSku, r.displayName)) : [];

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-ink">مزامنة كتالوج سنونو</h1>
          <p className="text-[11px] text-muted">
            ملف تحديث سنونو هو حالة كتالوج سنونو الحالية — المطابقة بهوية SPI فقط (لا مطابقة بالاسم، وSKU/الباركود غير مطلوبين).
          </p>
        </div>
        <Link href="/v2/catalog/import" className="btn-ghost text-xs">تحديث الكتالوج العام من Excel</Link>
      </div>

      <section className="card space-y-3">
        {/* EXPLICIT import-mode choice — extremely visible, never defaulted,
            and a partial workbook is NEVER silently given removal semantics. */}
        <div className="grid gap-2 sm:grid-cols-2">
          {(["FULL", "PARTIAL"] as const).map((m) => (
            <label
              key={m}
              className={`cursor-pointer rounded-xl border-2 p-3 text-xs transition-colors ${
                mode === m
                  ? m === "FULL" ? "border-rose-400 bg-rose-50" : "border-emerald-400 bg-emerald-50"
                  : "border-slate-200 bg-white hover:bg-slate-50"
              }`}
            >
              <div className="flex items-center gap-2">
                <input type="radio" name="snoonu-mode" checked={mode === m} onChange={() => { setMode(m); setPreview(null); setConfirming(false); }} />
                <span className="font-semibold text-ink">{SNOONU_MODE_LABEL[m]}</span>
              </div>
              <p className={`mt-1 text-[10px] ${m === "FULL" ? "text-rose-700" : "text-emerald-700"}`}>{SNOONU_MODE_NOTICE[m]}</p>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} id="snoonu-sync-file" type="file" accept=".xlsx" className="text-xs" />
          <button type="button" className="btn-primary text-xs disabled:opacity-50" disabled={busy !== null || mode === null} onClick={() => void runPreview()}>
            {busy === "preview" ? "جارٍ المعاينة…" : "معاينة (قراءة فقط)"}
          </button>
          <button type="button" className="btn-ghost text-xs disabled:opacity-50" disabled={busy !== null} onClick={() => void downloadReturnFile()}>
            {busy === "return" ? "جارٍ التوليد…" : "تنزيل ملف تحديث سنونو (SKU/الباركود/السعر)"}
          </button>
        </div>
        <p className="text-[10px] text-muted">المعاينة لا تكتب شيئاً أبداً. التطبيق متاح للمالك فقط وبعد تأكيد صريح.</p>
        {error && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}
      </section>

      {preview && plan && (
        <>
          <section className="card space-y-2">
            <h2 className="text-sm font-semibold text-ink">الأعمدة المتعرَّف عليها — {preview.fileName}</h2>
            <div className="flex flex-wrap gap-1.5 text-[10px]">
              {preview.columns.map((c, i) => (
                <span key={i} className={`rounded-full border px-2 py-0.5 ${c.label ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-500"}`}>
                  <span dir="ltr" className="font-mono">{c.header || "—"}</span>{c.label ? ` ← ${c.label}` : " (غير مستخدم)"}
                </span>
              ))}
            </div>
          </section>

          <section className="card space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-ink">المعاينة (قراءة فقط)</h2>
              <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold ${plan.mode === "FULL" ? "border-rose-300 bg-rose-50 text-rose-700" : "border-emerald-300 bg-emerald-50 text-emerald-700"}`}>
                وضع الاستيراد: {SNOONU_MODE_LABEL[plan.mode]}
              </span>
            </div>
            <p className={`rounded-lg border px-3 py-2 text-[11px] ${plan.mode === "FULL" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>
              {SNOONU_MODE_NOTICE[plan.mode]}
            </p>
            {preview.recommendedMode !== plan.mode && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
                ⚠️ بنية هذا الملف توحي بوضع «{SNOONU_MODE_LABEL[preview.recommendedMode]}» — أنت اخترت
                «{SNOONU_MODE_LABEL[plan.mode]}». تأكد قبل التطبيق.
              </p>
            )}
            <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4 lg:grid-cols-8">
              {([
                ["صفوف الملف", plan.counts.totalExcelRows],
                ["مطابق", plan.counts.matchedExisting],
                ["بدون تغيير", plan.counts.unchanged],
                ["توفر ← غير متوفر", plan.counts.availabilityTrueToFalse],
                ["غير متوفر ← متوفر", plan.counts.availabilityFalseToTrue],
                ["تغييرات سعر", plan.counts.priceChanges],
                ["تغييرات محتوى", plan.counts.contentChanges],
                ["تغييرات SKU", plan.counts.skuChanges],
                ["تغييرات باركود", plan.counts.barcodeChanges],
                ["مراجعات سعر صفر", plan.counts.zeroPriceReviews],
                ["تعارضات هوية", plan.counts.identityCollisions],
                ["ربط منتجات موجودة", plan.counts.reconcileExisting],
                ["منتجات جديدة", plan.counts.newProducts],
                ["جديد بلا SKU", plan.counts.newMissingSku],
                ["جديد بلا باركود", plan.counts.newMissingBarcode],
                ["جديد بلا الاثنين", plan.counts.newMissingBoth],
                ["أُزيل من سنونو", plan.counts.removedFromSnoonu],
                ["تعارضات", plan.counts.conflicts],
                ["محظور", plan.counts.blocked],
              ] as const).map(([label, value]) => (
                <div key={label} className="rounded-lg border border-slate-200 px-2 py-1.5">
                  <div className="text-sm font-semibold tabular-nums text-ink">{value}</div>
                  <div className="text-[10px] text-muted">{label}</div>
                </div>
              ))}
            </div>
            {plan.applyBlocked && (
              <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                التطبيق محظور: SPI مكرر داخل الملف ({plan.duplicateSpis.length}) — أصلح الملف ثم أعد المعاينة.
              </p>
            )}
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="بحث بالـ SPI أو SKU أو الاسم…"
              className="input text-xs"
              dir="rtl"
            />
          </section>

          {filteredMatched.length > 0 && (
            <section className="card space-y-2">
              <h3 className="text-sm font-semibold text-ink">تحديثات على منتجات مطابقة ({filteredMatched.length})</h3>
              <div className="max-h-80 overflow-auto rounded-lg border border-slate-200">
                <table className="w-full min-w-[720px] text-right text-[11px]">
                  <thead className="bg-slate-50 text-muted"><tr>
                    <th className="px-2 py-1 font-medium">SPI</th><th className="px-2 py-1 font-medium">SKU</th>
                    <th className="px-2 py-1 font-medium">المنتج</th><th className="px-2 py-1 font-medium">التغييرات (من ← إلى)</th>
                  </tr></thead>
                  <tbody>
                    {filteredMatched.slice(0, 500).map((m) => (
                      <tr key={m.spi} className="border-t border-slate-100 align-top">
                        <td className="px-2 py-1 font-mono text-[10px]" dir="ltr">{m.spi}</td>
                        <td className="px-2 py-1 font-mono text-[10px]" dir="ltr">{m.productSku}</td>
                        <td className="px-2 py-1">{m.displayName}</td>
                        <td className="px-2 py-1">
                          {m.changes.map((c, i) => (
                            <div key={i} className="text-[10px]">
                              <span className="font-medium">{FIELD_LABEL[c.field] ?? c.field}:</span>{" "}
                              <span className="text-muted line-through" dir="auto">{c.from ?? "—"}</span>{" ← "}
                              <span className="text-emerald-700" dir="auto">{c.to}</span>
                            </div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {filteredNews.length > 0 && (
            <section className="card space-y-2">
              <h3 className="text-sm font-semibold text-ink">منتجات سنونو جديدة ({filteredNews.length})</h3>
              <div className="max-h-80 overflow-auto rounded-lg border border-slate-200">
                <table className="w-full min-w-[720px] text-right text-[11px]">
                  <thead className="bg-slate-50 text-muted"><tr>
                    <th className="px-2 py-1 font-medium">SPI</th><th className="px-2 py-1 font-medium">الاسم</th>
                    <th className="px-2 py-1 font-medium">SKU</th><th className="px-2 py-1 font-medium">باركود</th>
                    <th className="px-2 py-1 font-medium">السعر</th><th className="px-2 py-1 font-medium">التصنيف</th>
                  </tr></thead>
                  <tbody>
                    {filteredNews.slice(0, 500).map((n) => (
                      <tr key={n.spi} className="border-t border-slate-100">
                        <td className="px-2 py-1 font-mono text-[10px]" dir="ltr">{n.spi}</td>
                        <td className="px-2 py-1" dir="auto">{n.nameAr ?? n.nameEn ?? "—"}</td>
                        <td className="px-2 py-1 font-mono text-[10px]" dir="ltr">{n.sku ?? "—"}</td>
                        <td className="px-2 py-1 font-mono text-[10px]" dir="ltr">{n.barcode ?? "—"}</td>
                        <td className="px-2 py-1 tabular-nums">{n.price ?? "—"}</td>
                        <td className="px-2 py-1">
                          <span className={`rounded px-1.5 py-0.5 text-[10px] ${n.blocked ? "bg-rose-50 text-rose-700" : n.klass === "NEW" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>
                            {n.blocked ?? NEW_CLASS_LABEL[n.klass]}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-muted">
                SKU/الباركود الفارغان لا يمنعان الإنشاء — يُخزَّنان كهوية ناقصة (بدون اختراع قيم) حتى يصل ملف سنونو الثاني بنفس SPI.
              </p>
            </section>
          )}

          {filteredRemovals.length > 0 && (
            <section className="card space-y-2">
              <h3 className="text-sm font-semibold text-rose-700">أُزيل من سنونو ({filteredRemovals.length})</h3>
              <p className="text-[10px] text-muted">
                هذه المنتجات مربوطة بسنونو لكن SPI غائب من الملف الجديد — سيُوقَف المنتج (STOPPED) ويُؤرشف الربط. لا حذف نهائي: الهوية والطلبات والسجل تبقى.
              </p>
              <div className="max-h-80 overflow-auto rounded-lg border border-rose-200">
                <table className="w-full min-w-[640px] text-right text-[11px]">
                  <thead className="bg-rose-50 text-rose-700"><tr>
                    <th className="px-2 py-1 font-medium">SPI</th><th className="px-2 py-1 font-medium">SKU</th><th className="px-2 py-1 font-medium">المنتج</th>
                  </tr></thead>
                  <tbody>
                    {filteredRemovals.slice(0, 500).map((r) => (
                      <tr key={r.productId} className="border-t border-rose-100">
                        <td className="px-2 py-1 font-mono text-[10px]" dir="ltr">{r.spi}</td>
                        <td className="px-2 py-1 font-mono text-[10px]" dir="ltr">{r.productSku}</td>
                        <td className="px-2 py-1">{r.displayName}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {plan.reconciles.length > 0 && (
            <section className="card space-y-2">
              <h3 className="text-sm font-semibold text-sky-800">ربط منتجات موجودة ({plan.reconciles.length})</h3>
              <p className="text-[10px] text-muted">
                صفوف بلا SPI مطابق، لكن SKU والباركود المستوردين يطابقان معاً نفس المنتج الموجود بالضبط —
                سيُربط SPI بالمنتج الموجود فقط: لا إنشاء منتج جديد، لا تغيير SKU/باركود، لا دمج.
              </p>
              <div className="max-h-72 overflow-auto rounded-lg border border-sky-200">
                <table className="w-full min-w-[860px] text-right text-[11px]">
                  <thead className="bg-sky-50 text-sky-800"><tr>
                    <th className="px-2 py-1 font-medium">SPI</th>
                    <th className="px-2 py-1 font-medium">المستورد (SKU/باركود)</th>
                    <th className="px-2 py-1 font-medium">المنتج الموجود (SKU/باركود)</th>
                    <th className="px-2 py-1 font-medium">الاسم</th>
                    <th className="px-2 py-1 font-medium">ربط سنونو الحالي</th>
                    <th className="px-2 py-1 font-medium">الإجراء المخطط</th>
                  </tr></thead>
                  <tbody>
                    {plan.reconciles.map((rec) => (
                      <tr key={rec.spi} className="border-t border-sky-100">
                        <td className="px-2 py-1 font-mono text-[10px]" dir="ltr">{rec.spi}</td>
                        <td className="px-2 py-1 font-mono text-[10px]" dir="ltr">{rec.importedSku} / {rec.importedBarcode}</td>
                        <td className="px-2 py-1 font-mono text-[10px]" dir="ltr">{rec.canonicalSku} / {rec.canonicalBarcode ?? "—"}</td>
                        <td className="px-2 py-1">{rec.displayName}</td>
                        <td className="px-2 py-1 text-muted">
                          {rec.currentSnoonuMapping
                            ? <>معرّف قديم: <span className="font-mono text-[10px]" dir="ltr">{rec.currentSnoonuMapping}</span> (سيُؤرشف)</>
                            : "لا يوجد"}
                        </td>
                        <td className="px-2 py-1 text-sky-800">ربط SPI بمنتج موجود — بدون إنشاء منتج جديد</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {plan.zeroPriceReviews.length > 0 && (
            <section className="card space-y-2">
              <h3 className="text-sm font-semibold text-amber-800">مراجعة السعر — السعر صفر ({plan.zeroPriceReviews.length})</h3>
              <p className="text-[10px] text-muted">
                سعر صفر لا يستبدل سعراً موجباً تلقائياً أبداً. لكل صف قرار صريح: الاحتفاظ بالسعر الحالي (الافتراضي)
                أو اعتماد السعر صفر. بقية حقول الصف الآمنة تُطبَّق طبيعياً.
              </p>
              <div className="max-h-60 overflow-auto rounded-lg border border-amber-200">
                <table className="w-full min-w-[680px] text-right text-[11px]">
                  <thead className="bg-amber-50 text-amber-800"><tr>
                    <th className="px-2 py-1 font-medium">SKU</th><th className="px-2 py-1 font-medium">المنتج</th>
                    <th className="px-2 py-1 font-medium">السعر الحالي</th><th className="px-2 py-1 font-medium">المقترح</th>
                    <th className="px-2 py-1 font-medium">القرار</th>
                  </tr></thead>
                  <tbody>
                    {plan.zeroPriceReviews.map((z) => (
                      <tr key={z.spi} className="border-t border-amber-100">
                        <td className="px-2 py-1 font-mono text-[10px]" dir="ltr">{z.productSku}</td>
                        <td className="px-2 py-1">{z.displayName}</td>
                        <td className="px-2 py-1 font-semibold tabular-nums text-emerald-700">{z.currentPrice}</td>
                        <td className="px-2 py-1 font-semibold tabular-nums text-rose-700">0</td>
                        <td className="px-2 py-1">
                          <label className="ml-3 inline-flex items-center gap-1">
                            <input
                              type="radio"
                              name={`zero-${z.spi}`}
                              checked={!zeroAccepted.has(z.spi)}
                              onChange={() => setZeroAccepted((s) => { const n = new Set(s); n.delete(z.spi); return n; })}
                            />
                            الاحتفاظ بالسعر الحالي
                          </label>
                          <label className="inline-flex items-center gap-1">
                            <input
                              type="radio"
                              name={`zero-${z.spi}`}
                              checked={zeroAccepted.has(z.spi)}
                              onChange={() => setZeroAccepted((s) => new Set(s).add(z.spi))}
                            />
                            اعتماد السعر صفر
                          </label>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {plan.identityCollisions.length > 0 && (
            <section className="card space-y-2">
              <h3 className="text-sm font-semibold text-rose-700">تعارض هوية المنتج ({plan.identityCollisions.length})</h3>
              <p className="text-[10px] text-muted">
                المعرّف المقترح مملوك لمنتج آخر — لن يُطبَّق أي تغيير هوية ولن يُدمج أو يُحذف شيء.
                الحل يتم في خطوة منفصلة يقررها المالك (أي هوية تبقى).
              </p>
              <div className="max-h-72 overflow-auto rounded-lg border border-rose-200">
                <table className="w-full min-w-[860px] text-right text-[11px]">
                  <thead className="bg-rose-50 text-rose-700"><tr>
                    <th className="px-2 py-1 font-medium">SPI</th>
                    <th className="px-2 py-1 font-medium">المنتج المصدر (SKU/باركود)</th>
                    <th className="px-2 py-1 font-medium">المقترح (SKU/باركود)</th>
                    <th className="px-2 py-1 font-medium">المنتج المتعارض</th>
                    <th className="px-2 py-1 font-medium">حل التكرار</th>
                  </tr></thead>
                  <tbody>
                    {plan.identityCollisions.map((ic, i) => (
                      <tr key={i} className="border-t border-rose-100 align-top">
                        <td className="px-2 py-1 font-mono text-[10px]" dir="ltr">{ic.spi}</td>
                        <td className="px-2 py-1 font-mono text-[10px]" dir="ltr">
                          {ic.source ? `${ic.source.sku} / ${ic.source.barcode ?? "—"}` : "— (صف جديد)"}
                        </td>
                        <td className="px-2 py-1 font-mono text-[10px]" dir="ltr">{ic.proposed.sku ?? "—"} / {ic.proposed.barcode ?? "—"}</td>
                        <td className="px-2 py-1">
                          <div className="font-mono text-[10px]" dir="ltr">{ic.colliding.sku} / {ic.colliding.barcode ?? "—"}</div>
                          <div>{ic.colliding.name}</div>
                          <div className="font-mono text-[9px] text-muted" dir="ltr">{ic.colliding.productId}</div>
                        </td>
                        <td className="px-2 py-1">
                          {ic.source && (
                            <button type="button" className="btn-ghost px-2 py-0.5 text-[10px] disabled:opacity-50" disabled={dupBusy} onClick={() => void openDupAudit(ic.source!.sku ?? "", ic.colliding.sku)}>
                              معاينة حل التكرار (قراءة فقط)
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {dupAudit && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-[11px]" dir="rtl">
                  <div className="pb-1 font-semibold">معاينة حل التكرار (قراءة فقط)</div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {[dupAudit.a, dupAudit.b].map((sideAudit) => (
                      <div key={sideAudit.productId} className="rounded border border-slate-200 bg-white p-2">
                        <div className="font-mono text-[10px]" dir="ltr">{sideAudit.sku} · {sideAudit.barcode ?? "—"}</div>
                        <div>{sideAudit.nameEn ?? sideAudit.nameAr ?? "—"}</div>
                        <div className="text-[10px] text-muted">
                          فئة: {sideAudit.category ?? "—"} · سعر: {sideAudit.price ?? "—"} · توفر: {sideAudit.stockStatus ?? "—"} · حالة: {sideAudit.lifecycleState ?? "—"} · خيارات: {sideAudit.variantCount}
                        </div>
                        <div className="text-[10px] text-muted">
                          روابط القنوات: {sideAudit.listings.map((l) => `${l.storefrontKey}(${l.mappingStatus})`).join("، ") || "—"}
                        </div>
                        <div className="text-[10px] text-muted">
                          مراجع حزم رفيق: {sideAudit.packageItemRefs ?? "غير متاح"} · سجل المنصات: {sideAudit.platformStatusRefs ?? "غير متاح"} · أُنشئ: {sideAudit.createdAt?.slice(0, 10) ?? "—"}
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="pt-1 text-[10px] text-amber-800">{dupAudit.note}</p>
                </div>
              )}
            </section>
          )}

          {(plan.conflicts.length > 0 || plan.blockedRows.length > 0) && (
            <section className="card space-y-2">
              <h3 className="text-sm font-semibold text-amber-800">تعارضات / صفوف محظورة ({plan.conflicts.length + plan.blockedRows.length})</h3>
              <div className="max-h-60 overflow-auto rounded-lg border border-amber-200">
                <table className="w-full min-w-[560px] text-right text-[11px]">
                  <tbody>
                    {[...plan.conflicts, ...plan.blockedRows].map((p, i) => (
                      <tr key={i} className="border-t border-amber-100">
                        <td className="px-2 py-1 tabular-nums">{p.rowNum ?? "—"}</td>
                        <td className="px-2 py-1 font-mono text-[10px]" dir="ltr">{p.spi ?? p.productSku ?? "—"}</td>
                        <td className="px-2 py-1">{p.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="card space-y-2">
            {applied ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                ✓ طُبِّقت المزامنة. تحديثات: {applied.results.filter((r) => r.action === "updated").length} · توفر: {applied.results.filter((r) => r.action === "availability").length} · جديد: {applied.results.filter((r) => r.action === "created").length} · موقوف: {applied.results.filter((r) => r.action === "removed").length} · فشل: {applied.results.filter((r) => r.action === "failed").length}
                {!applied.auditRecorded && <div className="pt-1 text-amber-800">تنبيه: لم يُسجَّل سجل التدقيق (جدول snoonu_sync_audits غير مهيأ).</div>}
              </div>
            ) : !isOwner ? (
              <p className="text-[11px] text-muted">🔒 التطبيق متاح للمالك فقط — المعاينة أعلاه قراءة فقط.</p>
            ) : confirming ? (
              <div className="space-y-2">
                <p className={`rounded-lg border px-3 py-2 text-xs font-semibold ${plan.mode === "FULL" ? "border-rose-300 bg-rose-50 text-rose-800" : "border-emerald-300 bg-emerald-50 text-emerald-800"}`}>
                  وضع الاستيراد: {SNOONU_MODE_LABEL[plan.mode]} — {SNOONU_MODE_NOTICE[plan.mode]}
                </p>
                <p className="text-xs text-ink">
                  تأكيد نهائي: سيُطبَّق ما في المعاينة أعلاه حرفياً ({plan.counts.matchedExisting - plan.counts.unchanged} تحديث ·{" "}
                  {plan.counts.newProducts} جديد · ربط منتجات موجودة: {plan.counts.reconcileExisting} · {plan.counts.removedFromSnoonu} إيقاف ·
                  اعتماد سعر صفر: {zeroAccepted.size} من {plan.counts.zeroPriceReviews} · تعارضات هوية محجوبة: {plan.counts.identityCollisions}).
                  لا شيء آخر سيتغير.
                </p>
                <div className="flex items-center gap-2">
                  <button type="button" className="btn-ghost text-xs" onClick={() => setConfirming(false)}>إلغاء</button>
                  <button type="button" className="btn-primary text-xs disabled:opacity-50" disabled={busy !== null} onClick={() => void runApply()}>
                    {busy === "apply" ? "جارٍ التطبيق…" : "تطبيق الآن (نهائي)"}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="btn-primary text-xs disabled:cursor-not-allowed disabled:opacity-50"
                disabled={busy !== null || plan.applyBlocked}
                onClick={() => setConfirming(true)}
              >
                تطبيق المزامنة…
              </button>
            )}
          </section>
        </>
      )}
    </div>
  );
}
