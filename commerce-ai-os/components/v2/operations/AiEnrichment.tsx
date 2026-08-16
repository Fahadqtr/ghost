"use client";

// CH.6E — Bulk AI Product Enrichment operator surface.
//
// Read-only Scan → writer-gated Generate (preview only, NEVER writes) → operator
// review/selection → writer-gated Apply Selected. The component never writes: it
// calls server actions, which route the apply through the narrow Catalog metadata
// boundary. "Generate All Eligible" produces suggestions only — it does not apply.

import { useMemo, useState, useTransition } from "react";
import {
  scanEnrichmentAction,
  generateEnrichmentAction,
  generateAllEligibleAction,
  applyEnrichmentAction,
} from "@/app/(v2)/v2/operations/ai-enrichment-actions";
import type { ScanResult, GenerateResult, ApplyResult } from "@/lib/enrichment/enrichment.server";
import type { Suggestion } from "@/lib/enrichment/enrichment-plan";

const FIELD_LABEL: Record<string, string> = {
  keywords_en: "Keywords (EN)", keywords_ar: "الكلمات (AR)",
  description_en: "Description (EN)", description_ar: "الوصف (AR)",
};
const STATUS_TONE: Record<string, string> = {
  READY: "text-emerald-600", UNCHANGED: "text-slate-500", NEEDS_REVIEW: "text-indigo-600",
  INSUFFICIENT_DATA: "text-amber-600", FAILED: "text-rose-600",
};

function sKey(s: { productId: string; field: string }): string { return `${s.productId}::${s.field}`; }

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`rounded-xl border px-3 py-2 text-center ${tone}`}>
      <div className="text-lg font-bold">{value}</div>
      <div className="text-[11px] font-medium opacity-80">{label}</div>
    </div>
  );
}

export default function AiEnrichment({ canWrite, brands, categories, initialFilters }: { canWrite: boolean; brands: string[]; categories: string[]; initialFilters?: Partial<{ brand: string; category: string; sku: string; field: string }> }) {
  const [filters, setFilters] = useState<{ brand: string; category: string; sku: string; field: string }>({ brand: "", category: "", sku: "", field: "", ...initialFilters });
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [selProducts, setSelProducts] = useState<Set<string>>(new Set());
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [genStats, setGenStats] = useState<GenerateResult["stats"] | null>(null);
  const [selSug, setSelSug] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<ApplyResult | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const readySug = useMemo(() => (suggestions ?? []).filter((s) => s.status === "READY"), [suggestions]);

  function reset() { setScan(null); setSelProducts(new Set()); setSuggestions(null); setGenStats(null); setSelSug(new Set()); setResults(null); setMsg(null); }

  function runScan() {
    reset();
    startTransition(async () => {
      const res = await scanEnrichmentAction(filters);
      if ("error" in res) { setMsg({ ok: false, text: res.error }); return; }
      setScan(res);
      setSelProducts(new Set(res.rows.map((r) => r.productId)));
      if (res.rows.length === 0) setMsg({ ok: true, text: "لا توجد منتجات تحتاج إثراءً بهذه الفلاتر." });
    });
  }

  function ingestGenerate(res: GenerateResult | { error: string }) {
    if ("error" in res) { setMsg({ ok: false, text: res.error }); return; }
    setSuggestions(res.suggestions);
    setGenStats(res.stats);
    setSelSug(new Set(res.suggestions.filter((s) => s.status === "READY" && s.autoEligible).map(sKey))); // MISSING pre-selected; WEAK needs explicit tick
    setResults(null);
    setMsg({ ok: true, text: `اقتراحات: ${res.stats.generated} جاهزة، ${res.stats.insufficient} بيانات غير كافية، ${res.stats.failed} فشل (نموذج ${res.stats.model}).` });
  }

  function generateSelected() {
    if (selProducts.size === 0) { setMsg({ ok: false, text: "اختر منتجًا واحدًا على الأقل." }); return; }
    setMsg(null);
    startTransition(async () => ingestGenerate(await generateEnrichmentAction([...selProducts], filters.field || undefined)));
  }
  function generateAll() {
    setMsg(null);
    startTransition(async () => ingestGenerate(await generateAllEligibleAction(filters)));
  }

  function toggle(set: Set<string>, key: string, setter: (s: Set<string>) => void) {
    const next = new Set(set); if (next.has(key)) next.delete(key); else next.add(key); setter(next);
  }

  function apply() {
    if (selSug.size === 0) { setMsg({ ok: false, text: "اختر اقتراحًا واحدًا على الأقل." }); return; }
    const approved = (suggestions ?? [])
      .filter((s) => selSug.has(sKey(s)) && s.status === "READY")
      .map((s) => ({ productId: s.productId, field: s.field, suggestedValue: s.suggestedValue, currentValueAtGen: s.currentValue }));
    setMsg(null);
    startTransition(async () => {
      const res = await applyEnrichmentAction(approved);
      if ("error" in res) { setMsg({ ok: false, text: res.error }); return; }
      setResults(res);
      setMsg({ ok: true, text: `تم: ${res.summary.updated} محدّث، ${res.summary.skipped} متجاوَز، ${res.summary.failed} فشل.` });
      // Suggestions that were applied are no longer selectable.
      const applied = new Set(res.results.filter((r) => r.status === "UPDATED").map((r) => `${r.productId}::${r.field}`));
      setSelSug((prev) => new Set([...prev].filter((k) => !applied.has(k))));
    });
  }

  const s = scan?.summary;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input placeholder="بحث SKU" value={filters.sku} onChange={(e) => setFilters({ ...filters, sku: e.target.value })} className="rounded-xl border border-slate-300 px-3 py-2 text-sm" />
        <select value={filters.brand} onChange={(e) => setFilters({ ...filters, brand: e.target.value })} className="rounded-xl border border-slate-300 px-3 py-2 text-sm">
          <option value="">كل العلامات</option>{brands.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <select value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })} className="rounded-xl border border-slate-300 px-3 py-2 text-sm">
          <option value="">كل الفئات</option>{categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={filters.field} onChange={(e) => setFilters({ ...filters, field: e.target.value })} className="rounded-xl border border-slate-300 px-3 py-2 text-sm">
          <option value="">كل الحقول</option>
          {Object.entries(FIELD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button onClick={runScan} disabled={isPending} className="rounded-xl bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50">🔍 فحص النواقص</button>
      </div>

      {msg && <div className={`rounded-xl border px-3 py-2 text-sm ${msg.ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}`}>{msg.text}</div>}

      {s && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          <Stat label="مفحوص" value={s.scanned} tone="border-slate-200 bg-slate-50 text-slate-600" />
          <Stat label="مرشّح" value={s.candidates} tone="border-slate-200 bg-slate-50 text-slate-600" />
          <Stat label="كلمات ناقصة" value={s.missingKeywords} tone="border-amber-200 bg-amber-50 text-amber-700" />
          <Stat label="أوصاف ناقصة" value={s.missingDescriptions} tone="border-amber-200 bg-amber-50 text-amber-700" />
          <Stat label="محتوى ضعيف" value={s.weakContent} tone="border-indigo-200 bg-indigo-50 text-indigo-700" />
          <Stat label="SEO (لا يوجد حقل)" value={s.missingSeo} tone="border-slate-200 bg-slate-50 text-slate-400" />
        </div>
      )}

      {canWrite && scan && scan.rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={generateSelected} disabled={isPending || selProducts.size === 0} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">✨ توليد المحدَّد ({selProducts.size})</button>
          <button onClick={generateAll} disabled={isPending} className="rounded-xl border border-indigo-300 px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-50">✨ توليد كل المؤهّل (حتى 100)</button>
          {genStats && <span className="text-xs text-muted">الاقتراحات لا تُطبَّق تلقائيًا — راجِع ثم طبِّق.</span>}
        </div>
      )}
      {!canWrite && scan && scan.rows.length > 0 && <span className="text-xs text-muted">🔒 التوليد والتطبيق متاحان لأصحاب صلاحية التعديل فقط.</span>}

      {scan && scan.rows.length > 0 && !suggestions && (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full min-w-[640px] text-right text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500"><tr>
              <th className="px-3 py-2 text-center"><input type="checkbox" checked={selProducts.size === scan.rows.length} onChange={() => setSelProducts(selProducts.size === scan.rows.length ? new Set() : new Set(scan.rows.map((r) => r.productId)))} aria-label="تحديد الكل" /></th>
              <th className="px-3 py-2">SKU</th><th className="px-3 py-2">المنتج</th><th className="px-3 py-2">حقول ناقصة/ضعيفة</th>
            </tr></thead>
            <tbody>
              {scan.rows.map((r) => (
                <tr key={r.productId} className="border-t border-slate-100">
                  <td className="px-3 py-2 text-center"><input type="checkbox" checked={selProducts.has(r.productId)} onChange={() => toggle(selProducts, r.productId, setSelProducts)} disabled={!canWrite} aria-label={`تحديد ${r.sku ?? r.productId}`} /></td>
                  <td className="px-3 py-2 font-mono text-xs">{r.sku ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">{r.name ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">{r.qualities.filter((q) => q.quality !== "GOOD").map((q) => `${FIELD_LABEL[q.field]}:${q.quality}`).join("، ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {suggestions && (
        <>
          {canWrite && <div className="flex items-center gap-2"><button onClick={apply} disabled={isPending || selSug.size === 0} className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">✅ تطبيق المحدَّد ({selSug.size})</button><button onClick={() => setSuggestions(null)} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-50">رجوع للقائمة</button></div>}
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full min-w-[900px] text-right text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500"><tr>
                <th className="px-3 py-2"></th><th className="px-3 py-2">SKU</th><th className="px-3 py-2">الحقل</th>
                <th className="px-3 py-2">الحالي</th><th className="px-3 py-2">المقترح</th><th className="px-3 py-2">الحالة</th><th className="px-3 py-2">ملاحظة</th>
              </tr></thead>
              <tbody>
                {suggestions.map((sg) => {
                  const k = sKey(sg);
                  return (
                    <tr key={k} className="border-t border-slate-100 align-top">
                      <td className="px-3 py-2 text-center">{sg.status === "READY" ? <input type="checkbox" checked={selSug.has(k)} onChange={() => toggle(selSug, k, setSelSug)} disabled={!canWrite} aria-label={`تحديد ${k}`} /> : null}</td>
                      <td className="px-3 py-2 font-mono text-xs">{sg.sku ?? "—"}</td>
                      <td className="px-3 py-2 text-xs">{FIELD_LABEL[sg.field]}{!sg.autoEligible && sg.status === "READY" ? " (ضعيف)" : ""}</td>
                      <td className="px-3 py-2 text-xs text-slate-500 max-w-[220px] truncate" title={sg.currentValue ?? ""}>{sg.currentValue ?? "—"}</td>
                      <td className="px-3 py-2 text-xs max-w-[280px]">{sg.suggestedValue || "—"}</td>
                      <td className={`px-3 py-2 text-xs font-semibold ${STATUS_TONE[sg.status] ?? ""}`}>{sg.status}</td>
                      <td className="px-3 py-2 text-xs text-slate-500">{sg.notes || sg.reason}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted">جاهزة: {readySug.length}. الحقول الضعيفة تتطلب تحديدًا صريحًا؛ الحقول الجيدة لا تُستبدل.</p>
        </>
      )}

      {results && (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <div className="border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-500">نتائج التطبيق ({results.summary.total})</div>
          <table className="w-full min-w-[560px] text-right text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-3 py-2">المنتج</th><th className="px-3 py-2">الحقل</th><th className="px-3 py-2">الحالة</th><th className="px-3 py-2">السبب</th></tr></thead>
            <tbody>
              {results.results.map((r) => (
                <tr key={`${r.productId}::${r.field}`} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-mono text-xs">{r.productId.slice(0, 8)}</td>
                  <td className="px-3 py-2 text-xs">{FIELD_LABEL[r.field]}</td>
                  <td className={`px-3 py-2 text-xs font-semibold ${r.status === "UPDATED" ? "text-emerald-600" : r.status === "FAILED" ? "text-rose-600" : "text-slate-500"}`}>{r.status}</td>
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
