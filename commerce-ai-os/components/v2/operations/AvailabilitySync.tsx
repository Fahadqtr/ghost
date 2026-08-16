"use client";

// CH.6C — Snoonu Availability Sync operator surface.
//
// Read-only Scan/Preview, writer-gated Apply. The component never writes: it calls
// the server actions, which route the apply through the Availability Engine only.
// Only actionable CHANGE rows are selectable; UNKNOWN / NEEDS_REVIEW / SKIPPED /
// UNCHANGED rows are shown for transparency but can never be applied.

import { useMemo, useState, useTransition } from "react";
import {
  scanSnoonuAvailabilityAction,
  applySnoonuAvailabilityAction,
} from "@/app/(v2)/v2/operations/availability-sync-actions";
import type {
  AvailabilityScanResult,
  AvailabilityApplyItem,
  AvailabilityApplySummary,
} from "@/lib/adapters/snoonu/availability/availability-sync.server";

const STOREFRONTS = [
  { key: "snoonu:pure_seoul", label: "Snoonu — Pure Seoul" },
  { key: "snoonu:malikas", label: "Snoonu — Malikas" },
] as const;

const ACTION_LABEL: Record<string, string> = {
  UNCHANGED: "بدون تغيير",
  CHANGE_TO_IN: "→ متوفّر",
  CHANGE_TO_OUT: "→ غير متوفّر",
  UNKNOWN: "غير معروف",
  NEEDS_REVIEW: "يحتاج مراجعة",
  SKIPPED: "متجاوَز",
};
const STATUS_LABEL: Record<string, string> = {
  UPDATED: "تم التحديث",
  UNCHANGED: "بدون تغيير",
  FAILED: "فشل",
  SKIPPED: "متجاوَز",
};

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`rounded-xl border px-3 py-2 text-center ${tone}`}>
      <div className="text-lg font-bold">{value}</div>
      <div className="text-[11px] font-medium opacity-80">{label}</div>
    </div>
  );
}

export default function AvailabilitySync({ canWrite, initialStorefront }: { canWrite: boolean; initialStorefront?: string }) {
  const [storefront, setStorefront] = useState<string>(initialStorefront ?? STOREFRONTS[0].key);
  const [scan, setScan] = useState<AvailabilityScanResult | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<AvailabilityApplyItem[] | null>(null);
  const [applySummary, setApplySummary] = useState<AvailabilityApplySummary | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const actionableRows = useMemo(() => (scan?.rows ?? []).filter((r) => r.actionable), [scan]);
  const allSelected = actionableRows.length > 0 && actionableRows.every((r) => selected.has(r.productId));

  function reset() {
    setScan(null);
    setShowPreview(false);
    setSelected(new Set());
    setResults(null);
    setApplySummary(null);
    setMsg(null);
  }

  function runScan() {
    reset();
    startTransition(async () => {
      const res = await scanSnoonuAvailabilityAction(storefront);
      if ("error" in res) { setMsg({ ok: false, text: res.error }); return; }
      setScan(res);
      // Pre-select every actionable change by default (operator can deselect).
      setSelected(new Set(res.rows.filter((r) => r.actionable).map((r) => r.productId)));
      if (res.sourceState !== "authenticated") {
        setMsg({ ok: true, text: "جلسة سنونو غير مُفعّلة بعد — لا توجد بيانات توفّر، ولن يُطبَّق أي تغيير (آمن)." });
      } else if (!res.sourceHasData) {
        setMsg({ ok: true, text: "لا توجد بيانات توفّر من سنونو لهذا المتجر حاليًا — كل المنتجات ستُتجاوَز بأمان." });
      }
    });
  }

  function toggle(productId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId); else next.add(productId);
      return next;
    });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(actionableRows.map((r) => r.productId)));
  }

  function apply() {
    if (selected.size === 0) { setMsg({ ok: false, text: "اختر تغييرًا واحدًا على الأقل." }); return; }
    setMsg(null);
    startTransition(async () => {
      const res = await applySnoonuAvailabilityAction(storefront, [...selected]);
      if ("error" in res) { setMsg({ ok: false, text: res.error }); return; }
      setResults(res.results);
      setApplySummary(res.summary);
      setMsg({ ok: true, text: `تم التطبيق: ${res.summary.updated} محدّث، ${res.summary.unchanged} دون تغيير، ${res.summary.skipped} متجاوَز، ${res.summary.failed} فشل.` });
      // Re-scan to reflect the new internal state.
      const fresh = await scanSnoonuAvailabilityAction(storefront);
      if (!("error" in fresh)) {
        setScan(fresh);
        setSelected(new Set(fresh.rows.filter((r) => r.actionable).map((r) => r.productId)));
      }
    });
  }

  const s = scan?.summary;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={storefront}
          onChange={(e) => { setStorefront(e.target.value); reset(); }}
          className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
          disabled={isPending}
        >
          {STOREFRONTS.map((sf) => <option key={sf.key} value={sf.key}>{sf.label}</option>)}
        </select>
        <button
          onClick={runScan}
          disabled={isPending}
          className="rounded-xl bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {isPending && !results ? "جارٍ الفحص…" : "🔍 فحص سنونو"}
        </button>
        <button
          onClick={() => setShowPreview((v) => !v)}
          disabled={!scan || isPending}
          className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-50"
        >
          {showPreview ? "إخفاء المعاينة" : "👁️ معاينة"}
        </button>
        {canWrite ? (
          <button
            onClick={apply}
            disabled={!scan || isPending || selected.size === 0}
            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {isPending && scan ? "جارٍ التطبيق…" : `✅ تطبيق المحدَّد (${selected.size})`}
          </button>
        ) : (
          <span className="text-xs text-muted">🔒 التطبيق متاح لأصحاب صلاحية التعديل فقط.</span>
        )}
      </div>

      {msg && (
        <div className={`rounded-xl border px-3 py-2 text-sm ${msg.ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
          {msg.text}
        </div>
      )}

      {s && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          <Stat label="متوفّر ↑" value={s.changeToIn} tone="border-emerald-200 bg-emerald-50 text-emerald-700" />
          <Stat label="غير متوفّر ↓" value={s.changeToOut} tone="border-amber-200 bg-amber-50 text-amber-700" />
          <Stat label="بدون تغيير" value={s.unchanged} tone="border-slate-200 bg-slate-50 text-slate-600" />
          <Stat label="غير معروف" value={s.unknown} tone="border-slate-200 bg-slate-50 text-slate-600" />
          <Stat label="يحتاج مراجعة" value={s.needsReview} tone="border-indigo-200 bg-indigo-50 text-indigo-700" />
          <Stat label="متجاوَز" value={s.skipped} tone="border-slate-200 bg-slate-50 text-slate-600" />
        </div>
      )}

      {showPreview && scan && (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full min-w-[720px] text-right text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2 text-center">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={actionableRows.length === 0 || !canWrite} aria-label="تحديد الكل" />
                </th>
                <th className="px-3 py-2">SKU</th>
                <th className="px-3 py-2">SPI</th>
                <th className="px-3 py-2">المتجر</th>
                <th className="px-3 py-2">الحالي</th>
                <th className="px-3 py-2">الوارد</th>
                <th className="px-3 py-2">الإجراء</th>
                <th className="px-3 py-2">السبب</th>
              </tr>
            </thead>
            <tbody>
              {scan.rows.map((r) => (
                <tr key={r.productId} className="border-t border-slate-100">
                  <td className="px-3 py-2 text-center">
                    {r.actionable ? (
                      <input type="checkbox" checked={selected.has(r.productId)} onChange={() => toggle(r.productId)} disabled={!canWrite || isPending} aria-label={`تحديد ${r.sku ?? r.productId}`} />
                    ) : null}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{r.sku ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.spi ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">{r.storefront}</td>
                  <td className="px-3 py-2 text-xs">{r.current ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">{r.incoming}</td>
                  <td className="px-3 py-2 text-xs font-semibold">{ACTION_LABEL[r.action] ?? r.action}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{r.reason}</td>
                </tr>
              ))}
              {scan.rows.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-400">لا توجد صفوف.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {results && (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <div className="border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-500">
            نتائج التطبيق {applySummary ? `(${applySummary.total})` : ""}
          </div>
          <table className="w-full min-w-[640px] text-right text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2">SKU</th>
                <th className="px-3 py-2">SPI</th>
                <th className="px-3 py-2">الحالة</th>
                <th className="px-3 py-2">من</th>
                <th className="px-3 py-2">إلى</th>
                <th className="px-3 py-2">السبب</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.productId} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-mono text-xs">{r.sku ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.spi ?? "—"}</td>
                  <td className={`px-3 py-2 text-xs font-semibold ${r.status === "UPDATED" ? "text-emerald-600" : r.status === "FAILED" ? "text-rose-600" : "text-slate-500"}`}>{STATUS_LABEL[r.status] ?? r.status}</td>
                  <td className="px-3 py-2 text-xs">{r.old ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">{r.new ?? "—"}</td>
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
