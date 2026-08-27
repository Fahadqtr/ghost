"use client";

// SNOONU AVAILABILITY SYNC — client surface.
//
// Three steps, nothing else on the page:
//   1. «رفع الملفات»        — the FULL catalog file and the BULK out-of-stock file
//   2. «معاينة المطابقة»    — the READ-ONLY census of the SPI join
//   3. «تطبيق حالة التوفر» — owner-only, behind an explicit confirmation
//
// The rule is membership: a product listed in BULK is out of stock; a product
// in the catalog and absent from BULK is in stock. Stock quantities are never
// read, so the page deliberately shows no stock-number explanation at all.

import { useRef, useState } from "react";
import Link from "next/link";
import {
  previewSnoonuAvailabilityAction,
  applySnoonuAvailabilityAction,
  type SnoonuAvailabilityPreviewVM,
} from "@/app/(v2)/v2/catalog/snoonu-sync/actions";
import { SNOONU_AVAILABILITY_RULE_AR } from "@/lib/snoonu/availability-sync";
import type { SnoonuAvailabilityApplyResult } from "@/lib/snoonu/availability-sync.server";

function Stat({ label, value, tone }: { label: string; value: number; tone?: "out" | "in" | "warn" }) {
  const color =
    tone === "out" ? "text-rose-700" : tone === "in" ? "text-emerald-700" : tone === "warn" ? "text-amber-700" : "text-ink";
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2">
      <div className="text-[10px] text-muted">{label}</div>
      <div className={`text-base font-semibold ${color}`}>{value}</div>
    </div>
  );
}

export default function SnoonuSync({ isOwner }: { isOwner: boolean }) {
  const fullRef = useRef<HTMLInputElement>(null);
  const bulkRef = useRef<HTMLInputElement>(null);

  const [preview, setPreview] = useState<SnoonuAvailabilityPreviewVM | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [confirming, setConfirming] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applied, setApplied] = useState<SnoonuAvailabilityApplyResult | null>(null);

  function files(): FormData | null {
    const f = fullRef.current?.files?.[0];
    const b = bulkRef.current?.files?.[0];
    if (!f || !b) return null;
    const fd = new FormData();
    fd.set("fullFile", f);
    fd.set("bulkFile", b);
    return fd;
  }

  async function runPreview() {
    const fd = files();
    if (!fd) { setError("ارفع الملفين معاً قبل المعاينة."); return; }
    setPreviewBusy(true);
    setError(null);
    setApplied(null);
    try {
      const res = await previewSnoonuAvailabilityAction(fd);
      if ("error" in res) { setError(res.error); setPreview(null); }
      else { setPreview(res.data); setError(null); }
    } finally {
      setPreviewBusy(false);
    }
  }

  async function runApply() {
    const fd = files();
    if (!fd || !preview) return;
    setApplyBusy(true);
    setError(null);
    try {
      fd.set("fingerprint", preview.plan.fingerprint);
      const res = await applySnoonuAvailabilityAction(fd);
      if ("error" in res) { setError(res.error); setApplied(null); }
      else { setApplied(res.data); setError(null); setPreview(null); }
      setConfirming(false);
    } finally {
      setApplyBusy(false);
    }
  }

  const c = preview?.plan.counts;

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">مزامنة حالة التوفر — سنونو</h1>
        <Link href="/v2/catalog/import" className="btn-ghost text-xs">تحديث الكتالوج العام من Excel</Link>
      </div>

      <div className="rounded-lg border-2 border-sky-300 bg-sky-50/50 px-3 py-2">
        <pre className="whitespace-pre-wrap font-sans text-xs leading-6 text-sky-950">{SNOONU_AVAILABILITY_RULE_AR}</pre>
      </div>

      {error && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}

      {/* ── 1 ── */}
      <section className="card space-y-3">
        <h2 className="text-sm font-semibold text-ink">١. رفع الملفات</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="label">ملف الكتالوج الكامل</span>
            <input ref={fullRef} type="file" accept=".xlsx" className="input text-xs" />
            <span className="block text-[10px] text-muted">كل منتجات سنونو — يحدد المنتجات التي تُقيَّم حالتها.</span>
          </label>
          <label className="space-y-1">
            <span className="label">ملف Bulk — المنتجات غير المتوفرة</span>
            <input ref={bulkRef} type="file" accept=".xlsx" className="input text-xs" />
            <span className="block text-[10px] text-muted">وجود المنتج في هذا الملف يعني «غير متوفر». غيابه لا يحذف أي منتج.</span>
          </label>
        </div>
        <button type="button" className="btn-primary text-xs disabled:opacity-50" disabled={previewBusy} onClick={() => void runPreview()}>
          {previewBusy ? "جارٍ المطابقة…" : "معاينة المطابقة (قراءة فقط)"}
        </button>
      </section>

      {/* ── 2 ── */}
      {preview && c && (
        <section className="card space-y-3">
          <h2 className="text-sm font-semibold text-ink">٢. معاينة المطابقة</h2>
          <p className="text-[10px] text-muted">
            الكتالوج: {preview.fullFile.name} — ورقة {preview.fullFile.sheet} · Bulk: {preview.bulkFile.name} — ورقة {preview.bulkFile.sheet}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="إجمالي منتجات الكتالوج" value={c.fullRows} />
            <Stat label="غير متوفر (موجود في Bulk)" value={c.outOfStock} tone="out" />
            <Stat label="متوفر (كتالوج بدون Bulk)" value={c.inStock} tone="in" />
            <Stat label="صفوف ملف Bulk" value={c.bulkRows} />
            <Stat label="SPI مطابق في الملفين" value={c.matchedSpi} />
            <Stat label="في الكتالوج فقط" value={c.fullOnly} />
            <Stat label="في Bulk فقط" value={c.bulkOnly} tone="warn" />
            <Stat label="غير مطابق / تعارض" value={c.conflicts} tone="warn" />
          </div>
          {preview.plan.applyBlocked && (
            <p className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800">
              التطبيق محظور: يوجد SPI مكرر داخل أحد الملفين ({preview.plan.duplicateSpis.length}) — أصلح الملف ثم أعد المعاينة.
            </p>
          )}
          {preview.plan.blocked.length > 0 && (
            <div className="max-h-56 overflow-auto rounded-lg border border-line">
              <table className="w-full text-[11px]">
                <thead className="bg-surface-2 text-muted">
                  <tr><th className="px-2 py-1 text-right">SPI</th><th className="px-2 py-1 text-right">السبب</th></tr>
                </thead>
                <tbody>
                  {preview.plan.blocked.map((b) => (
                    <tr key={`${b.spi}-${b.reason}`} className="border-t border-line">
                      <td className="px-2 py-1 font-mono text-[10px]">{b.spi}</td>
                      <td className="px-2 py-1">{b.messageAr}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ── 3 ── */}
      {preview && c && isOwner && (
        <section className="card space-y-3 border-2 border-emerald-300">
          <h2 className="text-sm font-semibold text-emerald-900">٣. تطبيق حالة التوفر</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="سيتحول إلى غير متوفر" value={c.changingToOut} tone="out" />
            <Stat label="سيتحول إلى متوفر" value={c.changingToIn} tone="in" />
            <Stat label="بدون تغيير" value={c.unchanged} />
            <Stat label="محظور / مراجعة" value={c.blocked} tone="warn" />
            <Stat label="عمليات حذف" value={c.removals} />
            <Stat label="تغييرات المحتوى" value={c.contentChanges} />
            <Stat label="تغييرات السعر" value={c.priceChanges} />
            <Stat label="تغييرات SKU / الباركود" value={c.skuChanges + c.barcodeChanges} />
          </div>
          <p className="text-[10px] text-muted">
            هذا التطبيق يغيّر حالة التوفر فقط. لا يغيّر السعر أو SKU أو الباركود أو الأسماء أو الأوصاف أو التصنيفات
            أو دورة الحياة، ولا يُنشئ منتجات، ولا يحذف أو يؤرشف أي منتج.
          </p>
          <button
            type="button"
            className="btn-primary text-xs disabled:opacity-50"
            disabled={applyBusy || preview.plan.applyBlocked || c.changingToOut + c.changingToIn === 0}
            onClick={() => setConfirming(true)}
          >
            {applyBusy ? "جارٍ التطبيق…" : "تطبيق حالة التوفر من Bulk"}
          </button>
          {confirming && (
            <div className="space-y-2 rounded-lg border border-emerald-400 bg-surface p-3">
              <p className="text-xs font-semibold text-ink">
                تأكيد: {c.changingToOut} منتج إلى «غير متوفر» و{c.changingToIn} منتج إلى «متوفر».
              </p>
              <p className="text-[10px] text-muted">لن يتم تطبيق أي تغيير آخر على المنتجات.</p>
              <div className="flex gap-2">
                <button type="button" className="btn-primary text-xs disabled:opacity-50" disabled={applyBusy} onClick={() => void runApply()}>
                  تطبيق الآن (نهائي)
                </button>
                <button type="button" className="btn-ghost text-xs" onClick={() => setConfirming(false)}>إلغاء</button>
              </div>
            </div>
          )}
        </section>
      )}

      {applied && (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          تم التطبيق — {applied.movedToOut} إلى «غير متوفر»، {applied.movedToIn} إلى «متوفر»، {applied.unchanged} بدون تغيير.
          {applied.auditRecorded ? " وسُجّل التدقيق." : " (تعذّر تسجيل التدقيق)"}
        </p>
      )}
    </div>
  );
}
