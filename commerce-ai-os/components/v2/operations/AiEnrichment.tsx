"use client";

// CH.6E — Bulk AI Product Enrichment operator surface.
//
// Read-only Scan → writer-gated Generate (preview only, NEVER writes) → operator
// review/selection → writer-gated Apply Selected. The component never writes: it
// calls server actions, which route the apply through the narrow Catalog metadata
// boundary. "Generate All Eligible" produces suggestions only — it does not apply.
//
// UX.1A — usability polish only (no logic/API change): three-level select
// controls (page / all filtered / clear) with an always-visible "X of Y" counter
// in a sticky bulk toolbar, client-side pagination (so a huge filtered set never
// renders thousands of checkboxes), clamped long values with expand/collapse +
// copy + tooltip, clearer row accents, and real empty states.

import { useMemo, useState, useTransition } from "react";
import {
  scanEnrichmentAction,
  generateEnrichmentAction,
  generateAllEligibleAction,
  applyEnrichmentAction,
} from "@/app/(v2)/v2/operations/ai-enrichment-actions";
import type { ScanResult, GenerateResult, ApplyResult } from "@/lib/enrichment/enrichment.server";
import type { Suggestion } from "@/lib/enrichment/enrichment-plan";
import { paginate, DEFAULT_PAGE_SIZE, type Page } from "@/lib/ui/pagination";
import {
  toggleKey,
  selectKeys,
  clearSelection,
  allSelected,
  countSelectedWithin,
} from "@/lib/ui/selection";
import SelectionToolbar from "@/components/v2/ui/SelectionToolbar";
import ClampText from "@/components/v2/ui/ClampText";
import EmptyState from "@/components/v2/ui/EmptyState";

const FIELD_LABEL: Record<string, string> = {
  keywords_en: "Keywords (EN)", keywords_ar: "الكلمات (AR)",
  description_en: "Description (EN)", description_ar: "الوصف (AR)",
};
const STATUS_TONE: Record<string, string> = {
  READY: "text-emerald-600", UNCHANGED: "text-slate-500", NEEDS_REVIEW: "text-indigo-600",
  INSUFFICIENT_DATA: "text-amber-600", FAILED: "text-rose-600",
};

function sKey(s: { productId: string; field: string }): string { return `${s.productId}::${s.field}`; }

/** Row accent (§4): selected → blue; failed/weak → orange/red; READY → green. */
function suggestionAccent(status: string, selected: boolean): string {
  if (selected) return "bg-blue-50 border-s-4 border-s-blue-400";
  if (status === "FAILED") return "border-s-4 border-s-rose-400";
  if (status === "INSUFFICIENT_DATA" || status === "NEEDS_REVIEW") return "border-s-4 border-s-amber-400";
  if (status === "READY") return "border-s-4 border-s-emerald-400";
  return "";
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`rounded-xl border px-3 py-2 text-center ${tone}`}>
      <div className="text-lg font-bold">{value}</div>
      <div className="text-[11px] font-medium opacity-80">{label}</div>
    </div>
  );
}

function Pager<T>({ page, onPage }: { page: Page<T>; onPage: (p: number) => void }) {
  if (page.total === 0) return null;
  return (
    <div className="flex items-center justify-between gap-2 px-1 text-xs text-muted">
      <span className="tabular-nums">{page.from}–{page.to} من {page.total}</span>
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => onPage(page.page - 1)} disabled={page.page <= 1}
          className="rounded-lg border border-slate-300 px-2 py-1 hover:bg-slate-50 disabled:opacity-40">السابق</button>
        <span className="tabular-nums">{page.page}/{page.pageCount}</span>
        <button type="button" onClick={() => onPage(page.page + 1)} disabled={page.page >= page.pageCount}
          className="rounded-lg border border-slate-300 px-2 py-1 hover:bg-slate-50 disabled:opacity-40">التالي</button>
      </div>
    </div>
  );
}

export default function AiEnrichment({ canWrite, brands, categories, initialFilters }: { canWrite: boolean; brands: string[]; categories: string[]; initialFilters?: Partial<{ brand: string; category: string; sku: string; field: string }> }) {
  const [filters, setFilters] = useState<{ brand: string; category: string; sku: string; field: string }>({ brand: "", category: "", sku: "", field: "", ...initialFilters });
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [selProducts, setSelProducts] = useState<Set<string>>(new Set());
  const [scanPage, setScanPage] = useState(1);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [selSug, setSelSug] = useState<Set<string>>(new Set());
  const [sugPage, setSugPage] = useState(1);
  const [results, setResults] = useState<ApplyResult | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const readySug = useMemo(() => (suggestions ?? []).filter((s) => s.status === "READY"), [suggestions]);

  // ── scan-table pagination + selection derivations (no quadratic render) ──────
  const scanRows = useMemo(() => scan?.rows ?? [], [scan]);
  const scanAllKeys = useMemo(() => scanRows.map((r) => r.productId), [scanRows]);
  const scanPageView = useMemo(() => paginate(scanRows, scanPage, DEFAULT_PAGE_SIZE), [scanRows, scanPage]);
  const scanPageKeys = useMemo(() => scanPageView.pageItems.map((r) => r.productId), [scanPageView]);
  const scanSelectedCount = useMemo(() => countSelectedWithin(selProducts, scanAllKeys), [selProducts, scanAllKeys]);

  // ── suggestions-table pagination + selection derivations (READY selectable) ──
  const allSug = useMemo(() => suggestions ?? [], [suggestions]);
  const sugAllKeys = useMemo(() => readySug.map(sKey), [readySug]);
  const sugPageView = useMemo(() => paginate(allSug, sugPage, DEFAULT_PAGE_SIZE), [allSug, sugPage]);
  const sugPageKeys = useMemo(
    () => sugPageView.pageItems.filter((s) => s.status === "READY").map(sKey),
    [sugPageView],
  );
  const sugSelectedCount = useMemo(() => countSelectedWithin(selSug, sugAllKeys), [selSug, sugAllKeys]);

  function reset() { setScan(null); setSelProducts(new Set()); setScanPage(1); setSuggestions(null); setSelSug(new Set()); setSugPage(1); setResults(null); setMsg(null); }

  function runScan() {
    reset();
    startTransition(async () => {
      const res = await scanEnrichmentAction(filters);
      if ("error" in res) { setMsg({ ok: false, text: res.error }); return; }
      setScan(res);
      setSelProducts(new Set(res.rows.map((r) => r.productId)));
      setScanPage(1);
      if (res.rows.length === 0) setMsg({ ok: true, text: "لا توجد منتجات تحتاج إثراءً بهذه الفلاتر." });
    });
  }

  function ingestGenerate(res: GenerateResult | { error: string }) {
    if ("error" in res) { setMsg({ ok: false, text: res.error }); return; }
    setSuggestions(res.suggestions);
    setSelSug(new Set(res.suggestions.filter((s) => s.status === "READY" && s.autoEligible).map(sKey))); // MISSING pre-selected; WEAK needs explicit tick
    setSugPage(1);
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

      {/* Empty state — a scan/filter that returned no candidates. */}
      {scan && scanRows.length === 0 && !suggestions && (
        <EmptyState
          title="لا توجد منتجات تحتاج إثراءً"
          message="لا توجد نتائج مطابقة للفلاتر الحالية. جرّب تعديل العلامة أو الفئة أو الحقل، أو امسح البحث ثم أعد الفحص."
        />
      )}

      {!canWrite && scan && scanRows.length > 0 && <span className="text-xs text-muted">🔒 التوليد والتطبيق متاحان لأصحاب صلاحية التعديل فقط.</span>}

      {/* SCAN review table — pick products to generate suggestions for. */}
      {scan && scanRows.length > 0 && !suggestions && (
        <div className="space-y-2">
          <SelectionToolbar
            selectedCount={scanSelectedCount}
            total={scanAllKeys.length}
            pageCount={scanPageKeys.length}
            pageAllSelected={allSelected(selProducts, scanPageKeys)}
            onSelectPage={() => setSelProducts((prev) => selectKeys(prev, scanPageKeys))}
            onSelectAllFiltered={() => setSelProducts((prev) => selectKeys(prev, scanAllKeys))}
            onClear={() => setSelProducts(clearSelection())}
          >
            {canWrite && (
              <>
                <button onClick={generateSelected} disabled={isPending || scanSelectedCount === 0} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">✨ توليد المحدَّد ({scanSelectedCount})</button>
                <button onClick={generateAll} disabled={isPending} className="rounded-xl border border-indigo-300 px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-50">✨ توليد كل المؤهّل (حتى 100)</button>
              </>
            )}
          </SelectionToolbar>

          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full min-w-[640px] text-right text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500"><tr>
                <th className="px-3 py-2 text-center">
                  <input type="checkbox" checked={scanPageKeys.length > 0 && allSelected(selProducts, scanPageKeys)}
                    onChange={() => setSelProducts((prev) => allSelected(prev, scanPageKeys) ? new Set([...prev].filter((k) => !scanPageKeys.includes(k))) : selectKeys(prev, scanPageKeys))}
                    disabled={!canWrite} aria-label="تحديد الصفحة" />
                </th>
                <th className="px-3 py-2">SKU</th><th className="px-3 py-2">المنتج</th><th className="px-3 py-2">حقول ناقصة/ضعيفة</th>
              </tr></thead>
              <tbody>
                {scanPageView.pageItems.map((r) => {
                  const selected = selProducts.has(r.productId);
                  return (
                    <tr key={r.productId} className={`border-t border-slate-100 ${selected ? "bg-blue-50 border-s-4 border-s-blue-400" : "border-s-4 border-s-amber-300"}`}>
                      <td className="px-3 py-2 text-center"><input type="checkbox" checked={selected} onChange={() => setSelProducts((prev) => toggleKey(prev, r.productId))} disabled={!canWrite} aria-label={`تحديد ${r.sku ?? r.productId}`} /></td>
                      <td className="px-3 py-2 font-mono text-xs">{r.sku ?? "—"}</td>
                      <td className="px-3 py-2 text-xs">{r.name ?? "—"}</td>
                      <td className="px-3 py-2 text-xs">{r.qualities.filter((q) => q.quality !== "GOOD").map((q) => `${FIELD_LABEL[q.field]}:${q.quality}`).join("، ")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager page={scanPageView} onPage={setScanPage} />
        </div>
      )}

      {/* SUGGESTIONS review table — approve + apply. */}
      {suggestions && (
        <div className="space-y-2">
          <SelectionToolbar
            selectedCount={sugSelectedCount}
            total={sugAllKeys.length}
            pageCount={sugPageKeys.length}
            pageAllSelected={allSelected(selSug, sugPageKeys)}
            onSelectPage={() => setSelSug((prev) => selectKeys(prev, sugPageKeys))}
            onSelectAllFiltered={() => setSelSug((prev) => selectKeys(prev, sugAllKeys))}
            onClear={() => setSelSug(clearSelection())}
          >
            {canWrite && (
              <>
                <button onClick={apply} disabled={isPending || sugSelectedCount === 0} className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">✅ تطبيق المحدَّد ({sugSelectedCount})</button>
                <button onClick={() => setSuggestions(null)} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-50">رجوع للقائمة</button>
              </>
            )}
          </SelectionToolbar>

          {allSug.length === 0 ? (
            <EmptyState
              title="لا توجد اقتراحات"
              message="لم يُنتج التوليد أي اقتراح قابل للتطبيق لهذه المنتجات. جرّب منتجات أخرى أو تحقّق من اكتمال البيانات."
            />
          ) : (
            <>
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full min-w-[900px] text-right text-sm">
                  <thead className="bg-slate-50 text-xs text-slate-500"><tr>
                    <th className="px-3 py-2 text-center">
                      <input type="checkbox" checked={sugPageKeys.length > 0 && allSelected(selSug, sugPageKeys)}
                        onChange={() => setSelSug((prev) => allSelected(prev, sugPageKeys) ? new Set([...prev].filter((k) => !sugPageKeys.includes(k))) : selectKeys(prev, sugPageKeys))}
                        disabled={!canWrite || sugPageKeys.length === 0} aria-label="تحديد الصفحة" />
                    </th>
                    <th className="px-3 py-2">SKU</th><th className="px-3 py-2">الحقل</th>
                    <th className="px-3 py-2">الحالي</th><th className="px-3 py-2">المقترح</th><th className="px-3 py-2">الحالة</th><th className="px-3 py-2">ملاحظة</th>
                  </tr></thead>
                  <tbody>
                    {sugPageView.pageItems.map((sg) => {
                      const k = sKey(sg);
                      const selected = sg.status === "READY" && selSug.has(k);
                      return (
                        <tr key={k} className={`border-t border-slate-100 align-top ${suggestionAccent(sg.status, selected)}`}>
                          <td className="px-3 py-2 text-center">{sg.status === "READY" ? <input type="checkbox" checked={selSug.has(k)} onChange={() => setSelSug((prev) => toggleKey(prev, k))} disabled={!canWrite} aria-label={`تحديد ${k}`} /> : null}</td>
                          <td className="px-3 py-2 font-mono text-xs">{sg.sku ?? "—"}</td>
                          <td className="px-3 py-2 text-xs">{FIELD_LABEL[sg.field]}{!sg.autoEligible && sg.status === "READY" ? " (ضعيف)" : ""}</td>
                          <td className="px-3 py-2 max-w-[240px]"><ClampText text={sg.currentValue} /></td>
                          <td className="px-3 py-2 max-w-[300px]"><ClampText text={sg.suggestedValue} /></td>
                          <td className={`px-3 py-2 text-xs font-semibold ${STATUS_TONE[sg.status] ?? ""}`}>{sg.status}</td>
                          <td className="px-3 py-2 text-xs text-slate-500">{sg.notes || sg.reason}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pager page={sugPageView} onPage={setSugPage} />
              <p className="text-xs text-muted">جاهزة: {readySug.length}. الحقول الضعيفة تتطلب تحديدًا صريحًا؛ الحقول الجيدة لا تُستبدل.</p>
            </>
          )}
        </div>
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
