"use client";

// CH.6D — Snoonu Barcode Completion operator surface.
//
// Read-only Scan/Preview, writer-gated Apply. The component never writes: it calls
// the server actions, which route the apply through the narrow Catalog barcode
// boundary. Only AUTO_COMPLETABLE rows are selectable; every other status
// (CONFLICT / DUPLICATE_INTERNAL / INVALID_SOURCE_BARCODE / NEEDS_REVIEW /
// NOT_FOUND) is shown for transparency but can never be applied.

import { useMemo, useState, useTransition } from "react";
import {
  scanBarcodeCompletionAction,
  applyBarcodeCompletionAction,
} from "@/app/(v2)/v2/operations/barcode-completion-actions";
import type {
  BarcodeScanResult,
  BarcodeApplyItem,
  BarcodeApplySummary,
} from "@/lib/adapters/snoonu/barcode/barcode-completion.server";
import type { BarcodeDiffRow } from "@/lib/adapters/snoonu/barcode/snoonu-barcode-diff";

const STATUS_LABEL: Record<string, string> = {
  AUTO_COMPLETABLE: "قابل للإكمال",
  UNCHANGED: "دون تغيير",
  CONFLICT: "تعارض",
  DUPLICATE_INTERNAL: "مكرر داخليًا",
  INVALID_SOURCE_BARCODE: "باركود مصدر غير صالح",
  NEEDS_REVIEW: "يحتاج مراجعة",
  NOT_FOUND: "غير موجود",
};
const APPLY_LABEL: Record<string, string> = {
  UPDATED: "تم الإكمال",
  UNCHANGED: "دون تغيير",
  SKIPPED: "متجاوَز",
  FAILED: "فشل",
  NEEDS_REVIEW: "يحتاج مراجعة",
};

function rowKey(r: BarcodeDiffRow): string {
  return r.targetKind === "variant" && r.variantId ? `variant:${r.variantId}` : `product:${r.productId}`;
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`rounded-xl border px-3 py-2 text-center ${tone}`}>
      <div className="text-lg font-bold">{value}</div>
      <div className="text-[11px] font-medium opacity-80">{label}</div>
    </div>
  );
}

export default function BarcodeCompletion({ canWrite }: { canWrite: boolean }) {
  const [scan, setScan] = useState<BarcodeScanResult | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<BarcodeApplyItem[] | null>(null);
  const [applySummary, setApplySummary] = useState<BarcodeApplySummary | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const actionableRows = useMemo(() => (scan?.rows ?? []).filter((r) => r.actionable), [scan]);
  const allSelected = actionableRows.length > 0 && actionableRows.every((r) => selected.has(rowKey(r)));

  function reset() {
    setScan(null); setShowPreview(false); setSelected(new Set()); setResults(null); setApplySummary(null); setMsg(null);
  }

  function runScan() {
    reset();
    startTransition(async () => {
      const res = await scanBarcodeCompletionAction();
      if ("error" in res) { setMsg({ ok: false, text: res.error }); return; }
      setScan(res);
      setSelected(new Set(res.rows.filter((r) => r.actionable).map(rowKey)));
      const live = Object.values(res.liveSourceStates);
      if (!live.includes("authenticated") && res.summary.autoCompletable === 0) {
        setMsg({ ok: true, text: "لا توجد جلسة سنونو مفعّلة ولا باركود مصدر محفوظ — لا يوجد ما يُكمَّل الآن (آمن)." });
      }
    });
  }

  function toggle(key: string) {
    setSelected((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(actionableRows.map(rowKey)));
  }

  function apply() {
    if (selected.size === 0) { setMsg({ ok: false, text: "اختر صفًا واحدًا على الأقل." }); return; }
    setMsg(null);
    startTransition(async () => {
      const res = await applyBarcodeCompletionAction([...selected]);
      if ("error" in res) { setMsg({ ok: false, text: res.error }); return; }
      setResults(res.results);
      setApplySummary(res.summary);
      setMsg({ ok: true, text: `تم: ${res.summary.updated} مكتمل، ${res.summary.unchanged} دون تغيير، ${res.summary.skipped} متجاوَز، ${res.summary.needsReview} مراجعة، ${res.summary.failed} فشل.` });
      const fresh = await scanBarcodeCompletionAction();
      if (!("error" in fresh)) { setScan(fresh); setSelected(new Set(fresh.rows.filter((r) => r.actionable).map(rowKey))); }
    });
  }

  const s = scan?.summary;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={runScan} disabled={isPending} className="rounded-xl bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50">
          {isPending && !results ? "جارٍ الفحص…" : "🔍 فحص"}
        </button>
        <button onClick={() => setShowPreview((v) => !v)} disabled={!scan || isPending} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-50">
          {showPreview ? "إخفاء المعاينة" : "👁️ معاينة"}
        </button>
        {canWrite ? (
          <button onClick={apply} disabled={!scan || isPending || selected.size === 0} className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
            {isPending && scan ? "جارٍ الإكمال…" : `✅ إكمال المحدَّد (${selected.size})`}
          </button>
        ) : (
          <span className="text-xs text-muted">🔒 الإكمال متاح لأصحاب صلاحية التعديل فقط.</span>
        )}
      </div>

      {msg && (
        <div className={`rounded-xl border px-3 py-2 text-sm ${msg.ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}`}>{msg.text}</div>
      )}

      {s && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          <Stat label="باركود ناقص" value={s.missingProduct + s.missingVariant} tone="border-slate-200 bg-slate-50 text-slate-600" />
          <Stat label="قابل للإكمال" value={s.autoCompletable} tone="border-emerald-200 bg-emerald-50 text-emerald-700" />
          <Stat label="تعارض" value={s.conflict} tone="border-amber-200 bg-amber-50 text-amber-700" />
          <Stat label="مكرر" value={s.duplicateInternal} tone="border-rose-200 bg-rose-50 text-rose-700" />
          <Stat label="يحتاج مراجعة" value={s.needsReview + s.invalidSource} tone="border-indigo-200 bg-indigo-50 text-indigo-700" />
          <Stat label="مكتمل مسبقًا" value={scan?.alreadyComplete ?? 0} tone="border-slate-200 bg-slate-50 text-slate-600" />
        </div>
      )}

      {showPreview && scan && (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full min-w-[820px] text-right text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2 text-center"><input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={actionableRows.length === 0 || !canWrite} aria-label="تحديد الكل" /></th>
                <th className="px-3 py-2">النوع</th>
                <th className="px-3 py-2">SKU</th>
                <th className="px-3 py-2">الاسم</th>
                <th className="px-3 py-2">الباركود الحالي</th>
                <th className="px-3 py-2">المتاجر</th>
                <th className="px-3 py-2">الوارد</th>
                <th className="px-3 py-2">الحالة</th>
                <th className="px-3 py-2">السبب</th>
              </tr>
            </thead>
            <tbody>
              {scan.rows.map((r) => {
                const k = rowKey(r);
                return (
                  <tr key={k} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-center">{r.actionable ? <input type="checkbox" checked={selected.has(k)} onChange={() => toggle(k)} disabled={!canWrite || isPending} aria-label={`تحديد ${r.sku ?? k}`} /> : null}</td>
                    <td className="px-3 py-2 text-xs">{r.targetKind === "variant" ? "خيار" : "منتج"}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.sku ?? "—"}</td>
                    <td className="px-3 py-2 text-xs">{r.name ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.currentBarcode ?? "—"}</td>
                    <td className="px-3 py-2 text-xs">{r.evidenceStorefronts.join("، ") || "—"}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.incoming ?? "—"}</td>
                    <td className="px-3 py-2 text-xs font-semibold">{STATUS_LABEL[r.status] ?? r.status}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{r.reason}</td>
                  </tr>
                );
              })}
              {scan.rows.length === 0 && <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-400">لا توجد صفوف ناقصة.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {results && (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <div className="border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-500">نتائج الإكمال {applySummary ? `(${applySummary.total})` : ""}</div>
          <table className="w-full min-w-[640px] text-right text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2">النوع</th>
                <th className="px-3 py-2">SKU</th>
                <th className="px-3 py-2">الحالة</th>
                <th className="px-3 py-2">من</th>
                <th className="px-3 py-2">إلى</th>
                <th className="px-3 py-2">السبب</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.variantId ?? r.productId} className="border-t border-slate-100">
                  <td className="px-3 py-2 text-xs">{r.targetKind === "variant" ? "خيار" : "منتج"}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.sku ?? "—"}</td>
                  <td className={`px-3 py-2 text-xs font-semibold ${r.status === "UPDATED" ? "text-emerald-600" : r.status === "FAILED" ? "text-rose-600" : "text-slate-500"}`}>{APPLY_LABEL[r.status] ?? r.status}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.old ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.new ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
