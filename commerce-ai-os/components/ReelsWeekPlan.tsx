"use client";

import { useState } from "react";
import { previewReelsWeek } from "@/app/(app)/content/actions";
import type { ReelPlanItem } from "@/lib/social/reels-plan";
import { qatarDayLabel, qatarTimeLabel } from "@/lib/social/schedule-compute";
import type { Locale } from "@/lib/i18n";

// Weekly Reels plan: 14 Reels/week across 5 formats, each with an English
// Higgsfield prompt (copy-paste), a Gulf-Arabic caption brief, a CTA type, and
// a 13:00/20:00 Doha slot. Read-only preview — the operator generates each
// video, writes the caption via the existing flow, then queues it.
export default function ReelsWeekPlan({ locale = "ar" }: { locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [items, setItems] = useState<ReelPlanItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");

  const build = async () => {
    setBusy(true); setErr(""); setNote("");
    try {
      const r = await previewReelsWeek(0);
      if ("error" in r) setErr(r.error);
      else setItems(r.items);
    } catch (e: any) {
      setErr(e?.message || L("تعذّر بناء الخطة", "Failed to build the plan"));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string, msg: string) => {
    try { await navigator.clipboard.writeText(text); setNote(msg); setTimeout(() => setNote(""), 1500); }
    catch { setNote(L("تعذّر النسخ", "Copy failed")); }
  };
  const copyAllPrompts = () =>
    copy((items ?? []).map((it, i) => `#${i + 1} [${it.format}] ${it.productName ?? ""}\n${it.promptEn}`).join("\n\n"),
      L("📋 نُسخت كل البرومبتات", "📋 Copied all prompts"));

  const FMT: Record<string, string> = {
    entertainment: "bg-pink-100 text-pink-700", street_interview: "bg-amber-100 text-amber-700",
    unboxing: "bg-violet-100 text-violet-700", review: "bg-emerald-100 text-emerald-700", asmr: "bg-sky-100 text-sky-700",
  };

  return (
    <div className="card space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-ink">🎬 {L("خطة الريلز الأسبوعية", "Weekly Reels plan")}</h3>
          <p className="text-xs text-muted">{L("١٤ ريل/أسبوع · ٥ صيغ · ١:٠٠م و٨:٠٠م بتوقيت الدوحة", "14 Reels/week · 5 formats · 13:00 & 20:00 Doha")}</p>
        </div>
        <div className="flex items-center gap-2">
          {items ? <button onClick={copyAllPrompts} className="btn-ghost px-3 py-1.5 text-xs">📋 {L("انسخ كل البرومبتات", "Copy all prompts")}</button> : null}
          <button onClick={build} disabled={busy} className="btn-primary px-4 py-1.5 text-sm disabled:opacity-50">
            {busy ? L("…", "…") : items ? L("🔄 أعِد البناء", "🔄 Rebuild") : L("✨ ابنِ خطة الأسبوع", "✨ Build the week")}
          </button>
        </div>
      </div>

      <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
        ⚠️ {L("النشر عبر الـAPI ما يدعم الأصوات الرائجة — الصيغ المؤمّنة (مراجعة/ASMR) بصوت أصلي تنشر تلقائيًا؛ اللي تحتاج ترند انشريها يدويًا من الجوال.",
          "API publishing can't use trending audio — the safe formats (review/ASMR, original sound) auto-publish; trend-audio ones post manually from the phone.")}
      </p>

      {err ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p> : null}
      {note ? <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{note}</p> : null}

      {items ? (
        <div className="space-y-2">
          {items.map((it) => (
            <div key={it.index} className="rounded-xl border border-[#efe3d6] bg-white p-3">
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold text-slate-500">#{it.index + 1}</span>
                <span className={`badge ${FMT[it.format] ?? "bg-slate-100 text-slate-600"}`}>{it.formatLabelAr}</span>
                <span className="text-xs text-muted">🕐 {qatarDayLabel(it.scheduledAtIso)} · {qatarTimeLabel(it.scheduledAtIso)}</span>
                <span className={`badge ${it.ctaType === "conversion" ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"}`}>
                  {it.ctaType === "conversion" ? L("تحويل", "conversion") : L("نمو", "growth")}
                </span>
                {it.apiAudioSafe
                  ? <span className="badge bg-emerald-100 text-emerald-700">{L("نشر تلقائي ✓", "auto ✓")}</span>
                  : <span className="badge bg-amber-100 text-amber-700">{L("يدوي (ترند)", "manual (trend)")}</span>}
              </div>
              <p className="text-sm font-semibold text-ink">{it.productName ?? "—"}{it.sku ? <span className="ms-1 text-[11px] font-normal text-muted">({it.sku})</span> : null}</p>
              <p className="mt-1 text-[11px] text-muted">{L("الكابشن:", "Caption brief:")} {it.captionGuideAr}</p>
              <div className="mt-2 flex items-start gap-2 rounded-lg bg-slate-50 p-2" dir="ltr">
                <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-slate-700">{it.promptEn}</p>
                <button onClick={() => copy(it.promptEn, L("📋 نُسخ البرومبت", "📋 Prompt copied"))}
                  className="shrink-0 rounded-md bg-slate-200 px-2 py-1 text-[11px] font-bold text-slate-700 hover:bg-slate-300">📋</button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="py-6 text-center text-sm text-muted">{L("اضغط «ابنِ خطة الأسبوع» لتوليد ١٤ ريل مجدولة بالبرومبتات.", "Tap “Build the week” to generate 14 scheduled Reels with prompts.")}</p>
      )}
    </div>
  );
}
