"use client";

import { useState } from "react";
import { listEnrichTargets, enrichProduct, type EnrichTarget, type EnrichOutcome } from "@/app/(app)/catalog/enrich/actions";
import ProductThumb from "@/components/ProductThumb";
import type { Locale } from "@/lib/i18n";

// AI catalog completion: find products missing Arabic name / Arabic description
// / category and let Claude fill them (matching the English) + verify the
// Arabic⇄English consistency and that the photo matches. Processes a few at a
// time with live progress; each row shows what was filled and any warning.

const MISS_LABEL: Record<string, string> = {
  name_ar: "اسم عربي", description_ar: "وصف عربي", main_category: "تصنيف",
};

export default function CatalogEnrich({ locale = "ar" }: { locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [targets, setTargets] = useState<EnrichTarget[] | null>(null);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [stop, setStop] = useState(false);
  const [done, setDone] = useState(0);
  const [err, setErr] = useState("");
  const [res, setRes] = useState<Record<string, EnrichOutcome>>({});

  const scan = async () => {
    setBusy(true); setErr(""); setRes({}); setDone(0);
    try {
      const r = await listEnrichTargets(all);
      if (!r.ok) { setErr(r.error ?? L("تعذّر", "Failed")); setTargets([]); }
      else setTargets(r.items);
    } catch (e: any) { setErr(e?.message || "خطأ"); }
    finally { setBusy(false); }
  };

  const runAll = async () => {
    if (!targets?.length) return;
    setRunning(true); setStop(false); setErr(""); setDone(0);
    const queue = [...targets];
    let stopped = false;
    const worker = async () => {
      while (queue.length) {
        if (stop) { stopped = true; return; }
        const t = queue.shift()!;
        try {
          const r = await enrichProduct(t.id, false);
          setRes((s) => ({ ...s, [t.id]: r }));
        } catch (e: any) {
          setRes((s) => ({ ...s, [t.id]: { ok: false, filled: [], arMatchesEn: null, imageMatches: null, notes: "", error: e?.message || "خطأ" } }));
        }
        setDone((n) => n + 1);
      }
    };
    // 3 concurrent to stay under model rate limits while making steady progress.
    await Promise.all([worker(), worker(), worker()]);
    setRunning(false);
    if (stopped) setErr(L("أُوقف — الباقي ما تعالج.", "Stopped — the rest weren't processed."));
  };

  const outcomeChips = (r: EnrichOutcome) => {
    const chips: { t: string; cls: string }[] = [];
    if (r.error) chips.push({ t: `❌ ${r.error}`, cls: "bg-red-50 text-red-700" });
    for (const f of r.filled) chips.push({ t: `✅ ${MISS_LABEL[f] ?? f}`, cls: "bg-emerald-50 text-emerald-700" });
    if (r.imageMatches === false) chips.push({ t: L("⚠️ الصورة لا تطابق", "⚠️ image mismatch"), cls: "bg-amber-50 text-amber-800" });
    if (r.arMatchesEn === false) chips.push({ t: L("⚠️ العربي كان مخالفًا", "⚠️ Arabic mismatched EN"), cls: "bg-amber-50 text-amber-800" });
    if (r.ok && !r.filled.length && r.imageMatches !== false && r.arMatchesEn !== false)
      chips.push({ t: L("✓ سليم", "✓ ok"), cls: "bg-slate-100 text-slate-500" });
    return chips;
  };

  const total = targets?.length ?? 0;

  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-ink">🤖 {L("إكمال الكتالوج بالذكاء", "AI catalog completion")}</h3>
            <p className="text-xs text-muted">{L("يولّد الاسم/الوصف العربي والتصنيف الناقص مطابقًا للإنجليزي، ويتحقّق إن الصورة تطابق المنتج.",
              "Fills the missing Arabic name/description & category to match the English, and checks the photo matches.")}</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11px] text-muted">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} disabled={busy || running} className="h-3.5 w-3.5" />
              {L("افحص كل المنتجات (أبطأ)", "Check every product (slower)")}
            </label>
            <button onClick={scan} disabled={busy || running} className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-50">
              {busy ? "…" : L("🔍 افحص الناقص", "🔍 Scan")}
            </button>
          </div>
        </div>

        {err ? <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p> : null}

        {targets ? (
          total === 0 ? (
            <p className="py-4 text-center text-sm text-emerald-700">✅ {L("ما في منتجات ناقصة — كل شيء مكتمل.", "Nothing missing — all complete.")}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <span className="rounded-full bg-slate-900 px-2.5 py-0.5 text-[13px] font-bold text-white">{total}</span>
              <span className="text-xs text-muted">{L("منتج للمعالجة", "products to process")}</span>
              {!running ? (
                <button onClick={runAll} className="btn-primary px-4 py-1.5 text-sm">🤖 {L("ولّد الناقص للكل", "Fill all with AI")}</button>
              ) : (
                <>
                  <span className="text-xs font-semibold text-violet-700">⏳ {done}/{total}</span>
                  <button onClick={() => setStop(true)} className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600">{L("إيقاف", "Stop")}</button>
                </>
              )}
              {!running && done > 0 ? <span className="text-xs text-muted">{L("تمت معالجة", "processed")} {done}</span> : null}
            </div>
          )
        ) : (
          <p className="py-4 text-center text-sm text-muted">{L("اضغط «افحص الناقص» لعرض المنتجات التي تحتاج إكمالًا بالذكاء.", "Tap “Scan” to list products needing AI completion.")}</p>
        )}
      </div>

      {targets && total > 0 ? (
        <div className="card space-y-2">
          {targets.slice(0, 300).map((t) => {
            const r = res[t.id];
            return (
              <div key={t.id} className="flex items-center gap-3 rounded-xl border border-[#efe3d6] bg-white p-2.5">
                <ProductThumb imageUrl={t.image_url} sku={t.sku} sizeClass="h-12 w-12" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink" dir="auto">{t.name_ar || t.name_en || t.sku || "—"}</p>
                  <p className="mt-0.5 truncate text-[11px] text-muted" dir="ltr">{t.name_en || ""} · {t.sku || "—"}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {t.missing.map((m) => <span key={m} className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">{L("ناقص", "missing")}: {MISS_LABEL[m] ?? m}</span>)}
                    {r ? outcomeChips(r).map((c, i) => <span key={i} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${c.cls}`}>{c.t}</span>) : null}
                  </div>
                </div>
                <a href={`/products/${t.id}/edit`} target="_blank" rel="noreferrer" className="btn-ghost shrink-0 px-2 py-1 text-xs">✏️</a>
              </div>
            );
          })}
          {total > 300 ? <p className="p-2 text-center text-xs text-slate-400">+{total - 300} {L("إضافية — تُعالَج كلها عند الضغط على «ولّد الناقص للكل»", "more — all are processed by “Fill all”")}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
