"use client";

// OPS.5 — Unified AI Enrichment Center (operator surface).
//
// Orchestrates the EXISTING CH.6E engine: read-only scan (server) → writer-gated
// Generate (preview only, NEVER writes) → focused review (approve/reject/edit/
// regenerate/skip) → writer-gated Apply Selected. It calls the existing CH.6E
// server actions and holds NO DB client and NO AI SDK. Generation is ephemeral
// (CH.6E persists nothing until apply); GOOD content is never auto-selected —
// only MISSING is pre-selected, WEAK needs an explicit tick.

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  generateEnrichmentAction,
  generateAllEligibleAction,
  applyEnrichmentAction,
} from "@/app/(v2)/v2/operations/ai-enrichment-actions";
import type { GenerateResult, ApplyResult } from "@/lib/enrichment/enrichment.server";
import type { Suggestion } from "@/lib/enrichment/enrichment-plan";
import {
  FIELD_LABEL,
  keywordDiff,
  classifySuggestion,
  ROUTES,
  type AiCenterModel,
  type AiFilters,
  type EnrichmentField,
} from "@/lib/operations/ai/ai-center";
import { fieldKind } from "@/lib/enrichment/enrichment-fields";

const STATUS_TONE: Record<string, string> = {
  READY: "text-emerald-600",
  UNCHANGED: "text-slate-500",
  NEEDS_REVIEW: "text-indigo-600",
  INSUFFICIENT_DATA: "text-amber-600",
  FAILED: "text-rose-600",
  APPLIED: "text-emerald-600",
};
const PROVIDER_TONE: Record<string, string> = {
  AVAILABLE: "border-emerald-200 bg-emerald-50 text-emerald-700",
  DEGRADED: "border-amber-200 bg-amber-50 text-amber-700",
  UNAVAILABLE: "border-slate-300 bg-slate-100 text-slate-600",
};

const sKey = (s: { productId: string; field: string }): string => `${s.productId}::${s.field}`;

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`rounded-xl border px-3 py-2 text-center ${tone}`}>
      <div className="text-lg font-bold">{value}</div>
      <div className="text-[11px] font-medium opacity-80">{label}</div>
    </div>
  );
}

export default function AiCenter({
  model,
  filters,
  canWrite,
  brands,
  categories,
}: {
  model: AiCenterModel;
  filters: AiFilters;
  canWrite: boolean;
  brands: string[];
  categories: string[];
}) {
  const [selProducts, setSelProducts] = useState<Set<string>>(() => new Set(model.needsGeneration.map((r) => r.productId)));
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [selSug, setSelSug] = useState<Set<string>>(new Set());
  const [edited, setEdited] = useState<Map<string, string>>(new Map());
  const [results, setResults] = useState<ApplyResult | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const d = model.dashboard;
  const diag = model.diagnostics;

  // live-session buckets (from the ephemeral suggestions)
  const buckets = useMemo(() => {
    const list = suggestions ?? [];
    return {
      ready: list.filter((s) => classifySuggestion(s) === "ready_review"),
      needs: list.filter((s) => classifySuggestion(s) === "needs_review"),
      failed: list.filter((s) => classifySuggestion(s) === "failed"),
    };
  }, [suggestions]);

  function toggle(set: Set<string>, key: string, setter: (s: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setter(next);
  }

  function ingest(res: GenerateResult | { error: string }, replaceOnly?: Set<string>) {
    if ("error" in res) {
      setMsg({ ok: false, text: res.error });
      return;
    }
    setSuggestions((prev) => {
      if (!prev || !replaceOnly) return res.suggestions;
      // regenerate/retry: replace only the affected keys, keep the rest
      const fresh = new Map(res.suggestions.map((s) => [sKey(s), s]));
      const merged = prev.map((s) => fresh.get(sKey(s)) ?? s);
      for (const s of res.suggestions) if (!prev.some((p) => sKey(p) === sKey(s))) merged.push(s);
      return merged;
    });
    // pre-select MISSING (autoEligible) READY only — WEAK/GOOD never auto-selected
    setSelSug((prev) => {
      const next = new Set(prev);
      for (const s of res.suggestions) if (s.status === "READY" && s.autoEligible) next.add(sKey(s));
      return next;
    });
    setResults(null);
    setMsg({ ok: true, text: `اقتراحات: ${res.stats.generated} جاهزة، ${res.stats.insufficient} بيانات غير كافية، ${res.stats.failed} فشل (نموذج ${res.stats.model}).` });
  }

  function generateSelected() {
    if (selProducts.size === 0) {
      setMsg({ ok: false, text: "اختر منتجًا واحدًا على الأقل." });
      return;
    }
    setMsg(null);
    startTransition(async () => ingest(await generateEnrichmentAction([...selProducts], filters.field ?? undefined)));
  }
  function generateAll() {
    setMsg(null);
    const f = { brand: filters.brand ?? "", category: filters.category ?? "", sku: filters.sku ?? "", field: filters.field ?? "" };
    startTransition(async () => ingest(await generateAllEligibleAction(f)));
  }
  function retryFailed() {
    const ids = [...new Set(buckets.failed.map((s) => s.productId))];
    if (ids.length === 0) return;
    setMsg(null);
    startTransition(async () => ingest(await generateEnrichmentAction(ids, filters.field ?? undefined), new Set(ids)));
  }
  function regenerate(productId: string, field: EnrichmentField) {
    setMsg(null);
    startTransition(async () => ingest(await generateEnrichmentAction([productId], field), new Set([productId])));
  }

  function apply() {
    const approved = (suggestions ?? [])
      .filter((s) => selSug.has(sKey(s)) && s.status === "READY")
      .map((s) => ({ productId: s.productId, field: s.field, suggestedValue: edited.get(sKey(s)) ?? s.suggestedValue, currentValueAtGen: s.currentValue }));
    if (approved.length === 0) {
      setMsg({ ok: false, text: "اختر اقتراحًا جاهزًا واحدًا على الأقل." });
      return;
    }
    setMsg(null);
    startTransition(async () => {
      const res = await applyEnrichmentAction(approved);
      if ("error" in res) {
        setMsg({ ok: false, text: res.error });
        return;
      }
      setResults(res);
      const stale = res.results.filter((r) => r.status === "SKIPPED" && /preview|stale|تغيّر/i.test(r.reason)).length;
      setMsg({ ok: true, text: `تم: ${res.summary.updated} محدّث، ${res.summary.skipped} متجاوَز${stale ? ` (منها ${stale} قديمة)` : ""}، ${res.summary.failed} فشل.` });
      const applied = new Set(res.results.filter((r) => r.status === "UPDATED").map((r) => `${r.productId}::${r.field}`));
      setSelSug((prev) => new Set([...prev].filter((k) => !applied.has(k))));
    });
  }

  return (
    <div className="space-y-4">
      {/* Provider diagnostics */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`rounded-lg border px-2.5 py-1 text-xs font-bold ${PROVIDER_TONE[diag.state]}`}>
          مزوّد الذكاء: {diag.state}
          {diag.lastSuccessAt ? <span className="opacity-70"> · آخر نجاح {diag.lastSuccessAt.slice(0, 10)}</span> : null}
        </span>
        <span className="text-[11px] text-muted">تقدير الطلبات: ~{model.estimatedRequests} · تزامن {`{`}CH.6E{`}`} · حتى 100/دفعة</span>
      </div>

      {/* Dashboard summary (§2) */}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-10">
        <Stat label="بحاجة ذكاء" value={d.productsNeedingAi} tone="border-slate-200 bg-slate-50 text-slate-600" />
        <Stat label="كلمات ناقصة" value={d.missingKeywords} tone="border-amber-200 bg-amber-50 text-amber-700" />
        <Stat label="كلمات ضعيفة" value={d.weakKeywords} tone="border-indigo-200 bg-indigo-50 text-indigo-700" />
        <Stat label="أوصاف ناقصة" value={d.missingDescriptions} tone="border-amber-200 bg-amber-50 text-amber-700" />
        <Stat label="أوصاف ضعيفة" value={d.weakDescriptions} tone="border-indigo-200 bg-indigo-50 text-indigo-700" />
        <Stat label="جاهزة" value={d.readySuggestions} tone="border-emerald-200 bg-emerald-50 text-emerald-700" />
        <Stat label="بحاجة مراجعة" value={d.needsReview} tone="border-indigo-200 bg-indigo-50 text-indigo-700" />
        <Stat label="فشل" value={d.failedGenerations} tone="border-rose-200 bg-rose-50 text-rose-700" />
        <Stat label="قديمة" value={d.staleSuggestions} tone="border-slate-200 bg-slate-50 text-slate-500" />
        <Stat label="طُبّقت مؤخرًا" value={d.recentlyApplied} tone="border-emerald-200 bg-emerald-50 text-emerald-700" />
      </div>
      <p className="text-[11px] text-muted">
        حقول مؤجّلة (لا توجد أعمدة): {d.deferred.map((x) => x.field).join("، ")}. عدّادات «جاهزة/مراجعة/فشل» للجلسة الحالية فقط —
        التوليد غير مُخزَّن؛ «طُبّقت مؤخرًا» من السجل الفعلي.
      </p>

      {/* Filters (§9/§10) — GET form; state reflected in the URL (shareable) */}
      <form action={ROUTES.ai} method="get" className="flex flex-wrap items-center gap-2">
        <input name="sku" placeholder="بحث SKU" defaultValue={filters.sku ?? ""} className="rounded-xl border border-slate-300 px-3 py-2 text-sm" />
        <select name="brand" defaultValue={filters.brand ?? ""} className="rounded-xl border border-slate-300 px-3 py-2 text-sm">
          <option value="">كل العلامات</option>
          {brands.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <select name="category" defaultValue={filters.category ?? ""} className="rounded-xl border border-slate-300 px-3 py-2 text-sm">
          <option value="">كل الفئات</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select name="field" defaultValue={filters.field ?? ""} className="rounded-xl border border-slate-300 px-3 py-2 text-sm">
          <option value="">كل الحقول</option>
          {model.fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        <select name="language" defaultValue={filters.language} className="rounded-xl border border-slate-300 px-3 py-2 text-sm">
          <option value="all">كل اللغات</option>
          <option value="ar">العربية</option>
          <option value="en">English</option>
        </select>
        <select name="quality" defaultValue={filters.quality ?? ""} className="rounded-xl border border-slate-300 px-3 py-2 text-sm">
          <option value="">كل الجودات</option>
          <option value="MISSING">MISSING</option>
          <option value="WEAK">WEAK</option>
        </select>
        <button type="submit" className="rounded-xl bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700">🔍 تطبيق الفلاتر</button>
        <Link href={ROUTES.ai} className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50">مسح</Link>
        <Link href={ROUTES.aiEnrichment} className="text-xs text-sky-700 hover:underline">الواجهة الكلاسيكية ↗</Link>
      </form>

      {msg && <div className={`rounded-xl border px-3 py-2 text-sm ${msg.ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}`}>{msg.text}</div>}

      {/* Generation controls (§5) */}
      {canWrite ? (
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={generateSelected} disabled={isPending || selProducts.size === 0} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">✨ توليد المحدَّد ({selProducts.size})</button>
          <button onClick={generateAll} disabled={isPending} className="rounded-xl border border-indigo-300 px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-50">✨ توليد كل المؤهّل (حتى 100)</button>
          {buckets.failed.length > 0 && <button onClick={retryFailed} disabled={isPending} className="rounded-xl border border-rose-300 px-4 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50">↻ إعادة المحاولة للفاشل ({buckets.failed.length})</button>}
          <span className="text-xs text-muted">الاقتراحات لا تُطبَّق تلقائيًا — راجِع ثم طبِّق المحدَّد فقط.</span>
        </div>
      ) : (
        <span className="text-xs text-muted">🔒 التوليد والتطبيق متاحان لأصحاب صلاحية التعديل فقط.</span>
      )}

      {/* Needs-Generation queue (from the read-only scan) */}
      {!suggestions && (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full min-w-[640px] text-right text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500"><tr>
              <th className="px-3 py-2 text-center"><input type="checkbox" checked={model.needsGeneration.length > 0 && selProducts.size === new Set(model.needsGeneration.map((r) => r.productId)).size} onChange={() => setSelProducts(selProducts.size > 0 ? new Set() : new Set(model.needsGeneration.map((r) => r.productId)))} aria-label="تحديد الكل" /></th>
              <th className="px-3 py-2">SKU</th><th className="px-3 py-2">المنتج</th><th className="px-3 py-2">العلامة</th><th className="px-3 py-2">الحقل</th><th className="px-3 py-2">الجودة</th><th className="px-3 py-2">السبب</th>
            </tr></thead>
            <tbody>
              {model.needsGeneration.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-xs text-muted">لا عناصر بحاجة توليد بهذه الفلاتر.</td></tr>}
              {model.needsGeneration.map((r) => (
                <tr key={r.key} className="border-t border-slate-100">
                  <td className="px-3 py-2 text-center"><input type="checkbox" checked={selProducts.has(r.productId)} onChange={() => toggle(selProducts, r.productId, setSelProducts)} disabled={!canWrite} aria-label={`تحديد ${r.sku ?? r.productId}`} /></td>
                  <td className="px-3 py-2 font-mono text-xs">{r.sku ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">{r.name ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">{r.brand ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">{r.field ? FIELD_LABEL[r.field] : "—"}</td>
                  <td className="px-3 py-2 text-xs font-semibold">{r.currentQuality}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Review workspace (§6/§7) */}
      {suggestions && (
        <>
          {canWrite && (
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={apply} disabled={isPending || selSug.size === 0} className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">✅ تطبيق المحدَّد ({selSug.size})</button>
              <button onClick={() => { setSuggestions(null); setResults(null); }} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-50">رجوع للقائمة</button>
              <span className="text-xs text-muted">جاهزة {buckets.ready.length} · بحاجة مراجعة {buckets.needs.length} · فشل {buckets.failed.length}</span>
            </div>
          )}
          <div className="space-y-2">
            {suggestions.map((sg) => {
              const k = sKey(sg);
              const isKw = fieldKind(sg.field) === "keywords";
              const kd = isKw ? keywordDiff(sg.currentValue, edited.get(k) ?? sg.suggestedValue) : null;
              const selectable = sg.status === "READY";
              return (
                <div key={k} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-xs">
                      <span className="font-mono">{sg.sku ?? "—"}</span> · <span className="font-semibold">{sg.productName ?? "—"}</span> · {FIELD_LABEL[sg.field]}
                      {!sg.autoEligible && sg.status === "READY" ? <span className="text-indigo-600"> (ضعيف — يتطلب تحديدًا)</span> : null}
                    </div>
                    <span className={`text-xs font-semibold ${STATUS_TONE[sg.status] ?? ""}`}>{sg.status}</span>
                  </div>

                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div className="rounded-lg bg-slate-50 p-2">
                      <div className="text-[10px] font-bold text-slate-400">الحالي ({sg.currentQuality})</div>
                      {isKw && kd ? (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {kd.current.length === 0 ? <span className="text-[11px] text-slate-400">—</span> : kd.current.map((t) => <span key={t} className={`rounded px-1.5 py-0.5 text-[11px] ${kd.removed.includes(t) ? "bg-rose-100 text-rose-700 line-through" : "bg-slate-200 text-slate-600"}`}>{t}</span>)}
                        </div>
                      ) : (
                        <p className="mt-1 text-[11px] text-slate-600">{sg.currentValue ?? "—"}</p>
                      )}
                    </div>
                    <div className="rounded-lg bg-emerald-50 p-2">
                      <div className="text-[10px] font-bold text-emerald-500">المقترح</div>
                      {isKw && kd ? (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {kd.suggested.length === 0 ? <span className="text-[11px] text-slate-400">—</span> : kd.suggested.map((t) => <span key={t} className={`rounded px-1.5 py-0.5 text-[11px] ${kd.added.includes(t) ? "bg-emerald-200 text-emerald-800 font-semibold" : "bg-emerald-100 text-emerald-700"}`}>{t}</span>)}
                        </div>
                      ) : canWrite && selectable ? (
                        <textarea value={edited.get(k) ?? sg.suggestedValue} onChange={(e) => setEdited((prev) => new Map(prev).set(k, e.target.value))} rows={2} className="mt-1 w-full rounded border border-emerald-200 bg-white p-1 text-[11px]" dir={sg.field.endsWith("_ar") ? "rtl" : "ltr"} />
                      ) : (
                        <p className="mt-1 text-[11px] text-slate-700">{sg.suggestedValue || "—"}</p>
                      )}
                    </div>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                    {selectable && canWrite && (
                      <label className="flex items-center gap-1 font-semibold text-emerald-700">
                        <input type="checkbox" checked={selSug.has(k)} onChange={() => toggle(selSug, k, setSelSug)} /> اعتماد (تحديد للتطبيق)
                      </label>
                    )}
                    {canWrite && <button onClick={() => regenerate(sg.productId, sg.field)} disabled={isPending} className="rounded border border-slate-300 px-2 py-0.5 hover:bg-slate-50 disabled:opacity-50">↻ إعادة توليد</button>}
                    {selectable && canWrite && selSug.has(k) && <button onClick={() => toggle(selSug, k, setSelSug)} className="rounded border border-slate-300 px-2 py-0.5 hover:bg-slate-50">تخطّي</button>}
                    <span className="text-slate-400">{sg.notes || sg.reason}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-muted">الحقول الجيدة (GOOD) لا تظهر ولا تُستبدل؛ التطبيق يفحص التقادم ويطبّق المحدَّد الجاهز فقط.</p>
        </>
      )}

      {/* Apply results (§14/§15) */}
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

      {/* Generation history (§11) — real applied events only */}
      {model.appliedRecent.length > 0 && (
        <div className="rounded-xl border border-slate-200 p-3">
          <h3 className="text-xs font-bold text-slate-700">سجل التطبيق الأخير (من السجل الفعلي)</h3>
          <ul className="mt-1 space-y-0.5 text-[11px] text-slate-600">
            {model.appliedRecent.map((r) => (
              <li key={r.key} className="flex items-center justify-between border-t border-slate-100 py-1 first:border-0">
                <span>{r.sku ?? "—"} · {r.field ? FIELD_LABEL[r.field] : "—"} · {r.reason}</span>
                <span className={`font-semibold ${STATUS_TONE[String(r.suggestionStatus)] ?? "text-slate-500"}`}>{r.suggestionStatus}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
