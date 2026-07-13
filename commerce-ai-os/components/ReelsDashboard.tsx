"use client";

import { useState } from "react";
import { reelsWeekStatus, type ReelQueueRow } from "@/app/(app)/content/actions";
import type { FormatWeekAvg } from "@/lib/social/reels-metrics";
import { REEL_FORMATS } from "@/lib/social/reels-plan";
import { qatarDayLabel, qatarTimeLabel } from "@/lib/social/schedule-compute";
import type { Locale } from "@/lib/i18n";

const LABEL: Record<string, string> = Object.fromEntries(REEL_FORMATS.map((f) => [f.key, f.labelAr]));
const FMT_CLS: Record<string, string> = {
  entertainment: "bg-pink-100 text-pink-700", street_interview: "bg-amber-100 text-amber-700",
  unboxing: "bg-violet-100 text-violet-700", review: "bg-emerald-100 text-emerald-700", asmr: "bg-sky-100 text-sky-700",
};

// Weekly Reels pipeline + per-format performance + the Sunday cut hint. Reads
// the format-tagged social_posts rows; views populate once reels are posted.
export default function ReelsDashboard({ locale = "ar" }: { locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [data, setData] = useState<{ queue: ReelQueueRow[]; perFormat: FormatWeekAvg[]; toCut: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = async () => {
    setBusy(true); setErr("");
    try {
      const r = await reelsWeekStatus();
      if ("error" in r) setErr(r.error);
      else setData(r);
    } catch (e: any) { setErr(e?.message || L("تعذّر", "Failed")); }
    finally { setBusy(false); }
  };

  const statusBadge = (r: ReelQueueRow) =>
    r.status === "posted" ? <span className="badge bg-green-100 text-green-700">{L("نُشر", "posted")}</span>
    : r.status === "failed" ? <span className="badge bg-red-100 text-red-700">{L("فشل", "failed")}</span>
    : r.approved ? <span className="badge bg-emerald-100 text-emerald-700">{L("معتمد · بالانتظار", "approved · scheduled")}</span>
    : <span className="badge bg-amber-100 text-amber-700">{L("بانتظار الاعتماد", "needs approval")}</span>;

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-ink">📊 {L("متابعة ريلز الأسبوع", "Reels pipeline")}</h3>
          <p className="text-xs text-muted">{L("المجدول + الأداء لكل صيغة + توصية مراجعة الأحد", "Queue + per-format performance + Sunday review")}</p>
        </div>
        <button onClick={load} disabled={busy} className="btn-primary px-4 py-1.5 text-sm disabled:opacity-50">
          {busy ? "…" : data ? L("🔄 حدّث", "🔄 Refresh") : L("📊 اعرض الحالة", "📊 Show status")}
        </button>
      </div>

      {err ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p> : null}

      {data ? (
        data.queue.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">{L("ما في ريلز مجدولة بعد — ابنِ الخطة أعلاه واضغط «جدولة» على العناصر.", "No Reels queued yet — build the plan above and “Queue” items.")}</p>
        ) : (
          <div className="space-y-4">
            {data.toCut.length > 0 ? (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
                ⚠️ {L("توصية الأحد — قلّل هذي الصيغ (أقل من ٥٠٪ من الوسيط أسبوعين):", "Sunday rule — cut these formats (<50% of median, 2 weeks):")} {data.toCut.map((k) => LABEL[k] ?? k).join(" · ")}
              </p>
            ) : null}

            {/* Per-format performance */}
            {data.perFormat.length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-semibold text-muted">{L("متوسّط المشاهدات لكل صيغة", "Avg views per format")}</p>
                <div className="flex flex-wrap gap-2">
                  {data.perFormat.map((f, i) => (
                    <span key={i} className={`badge ${FMT_CLS[f.format] ?? "bg-slate-100 text-slate-600"}`}>
                      {LABEL[f.format] ?? f.format}: {f.avgViews.toLocaleString()} {L("مشاهدة", "views")} ({f.count})
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-[11px] text-muted">{L("الأداء يظهر بعد نشر أول ريلز.", "Performance appears once reels are posted.")}</p>
            )}

            {/* Queue */}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-start text-[11px] uppercase text-muted">
                    <th className="px-2 py-1.5 font-medium">{L("الصيغة", "Format")}</th>
                    <th className="px-2 py-1.5 font-medium">{L("الموعد", "When")}</th>
                    <th className="px-2 py-1.5 font-medium">{L("CTA", "CTA")}</th>
                    <th className="px-2 py-1.5 font-medium">{L("الحالة", "Status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.queue.map((r, i) => (
                    <tr key={i} className="border-b border-slate-100">
                      <td className="px-2 py-1.5"><span className={`badge ${FMT_CLS[r.format] ?? "bg-slate-100 text-slate-600"}`}>{LABEL[r.format] ?? r.format}</span></td>
                      <td className="px-2 py-1.5 text-xs text-slate-600">{r.scheduledAtIso ? `${qatarDayLabel(r.scheduledAtIso)} · ${qatarTimeLabel(r.scheduledAtIso)}` : "—"}</td>
                      <td className="px-2 py-1.5 text-xs text-slate-500">{r.ctaType === "conversion" ? L("تحويل", "conversion") : L("نمو", "growth")}</td>
                      <td className="px-2 py-1.5">{statusBadge(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      ) : (
        <p className="py-6 text-center text-sm text-muted">{L("اضغط «اعرض الحالة» لمتابعة ريلز الأسبوع.", "Tap “Show status” to see the week's Reels pipeline.")}</p>
      )}
    </div>
  );
}
