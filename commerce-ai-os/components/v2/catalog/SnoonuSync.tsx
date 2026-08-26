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
  type SnoonuSyncPreviewVM,
} from "@/app/(v2)/v2/catalog/snoonu-sync/actions";
import type { SnoonuApplyResult } from "@/lib/snoonu/sync.server";

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

  function formDataWithFile(): FormData | null {
    const file = fileRef.current?.files?.[0];
    if (!file) { setError("اختر ملف Excel أولاً."); return null; }
    const fd = new FormData();
    fd.set("file", file);
    return fd;
  }

  async function runPreview() {
    const fd = formDataWithFile();
    if (!fd) return;
    setBusy("preview"); setError(null); setApplied(null); setPreview(null); setConfirming(false);
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
    if (!preview) return;
    const fd = formDataWithFile();
    if (!fd) return;
    fd.set("fingerprint", preview.plan.fingerprint);
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
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} id="snoonu-sync-file" type="file" accept=".xlsx" className="text-xs" />
          <button type="button" className="btn-primary text-xs disabled:opacity-50" disabled={busy !== null} onClick={() => void runPreview()}>
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
            <h2 className="text-sm font-semibold text-ink">المعاينة (قراءة فقط)</h2>
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
                <p className="text-xs text-ink">
                  تأكيد نهائي: سيُطبَّق ما في المعاينة أعلاه حرفياً ({plan.counts.matchedExisting - plan.counts.unchanged} تحديث ·{" "}
                  {plan.counts.newProducts} جديد · {plan.counts.removedFromSnoonu} إيقاف). لا شيء آخر سيتغير.
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
