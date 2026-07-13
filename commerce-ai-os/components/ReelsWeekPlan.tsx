"use client";

import { useState } from "react";
import { previewReelsWeek, queueReel, generateReelVideo, pollReelVideo } from "@/app/(app)/content/actions";
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
  const [vurl, setVurl] = useState<Record<number, string>>({});
  const [qstate, setQstate] = useState<Record<number, "idle" | "busy" | "done" | "error">>({});
  const [qerr, setQerr] = useState<Record<number, string>>({});
  const [gen, setGen] = useState<Record<number, "idle" | "working" | "error">>({});
  const [genErr, setGenErr] = useState<Record<number, string>>({});

  // Auto-generate the reel video in-system (Higgsfield image→video from the
  // product photo), then poll until ready and auto-fill the URL field.
  const generate = async (it: ReelPlanItem) => {
    if (!it.sku) { setGenErr((s) => ({ ...s, [it.index]: L("لا يوجد منتج", "No product") })); return; }
    setGen((s) => ({ ...s, [it.index]: "working" })); setGenErr((s) => ({ ...s, [it.index]: "" }));
    const r = await generateReelVideo({ sku: it.sku, prompt: it.promptEn });
    if ("error" in r) { setGen((s) => ({ ...s, [it.index]: "error" })); setGenErr((s) => ({ ...s, [it.index]: r.error })); return; }
    let attempts = 0;
    const tick = async () => {
      attempts++;
      const p = await pollReelVideo(r.requestId);
      if ("error" in p) { setGen((s) => ({ ...s, [it.index]: "error" })); setGenErr((s) => ({ ...s, [it.index]: p.error })); return; }
      if (p.videoUrl) { setVurl((s) => ({ ...s, [it.index]: p.videoUrl! })); setGen((s) => ({ ...s, [it.index]: "idle" })); return; }
      if (attempts > 40) { setGen((s) => ({ ...s, [it.index]: "error" })); setGenErr((s) => ({ ...s, [it.index]: L("طال وقت التوليد — جرّب مرة ثانية", "Timed out — try again") })); return; }
      setTimeout(tick, 15000);
    };
    setTimeout(tick, 15000);
  };

  const queue = async (it: ReelPlanItem) => {
    const url = (vurl[it.index] || "").trim();
    if (!url) { setQerr((s) => ({ ...s, [it.index]: L("الصق رابط الفيديو أول", "Paste the video URL first") })); return; }
    setQstate((s) => ({ ...s, [it.index]: "busy" })); setQerr((s) => ({ ...s, [it.index]: "" }));
    try {
      const r = await queueReel({ sku: it.sku, format: it.format, ctaType: it.ctaType, scheduledAtIso: it.scheduledAtIso, videoUrl: url });
      if ("error" in r) { setQstate((s) => ({ ...s, [it.index]: "error" })); setQerr((s) => ({ ...s, [it.index]: r.error })); }
      else setQstate((s) => ({ ...s, [it.index]: "done" }));
    } catch (e: any) {
      setQstate((s) => ({ ...s, [it.index]: "error" })); setQerr((s) => ({ ...s, [it.index]: e?.message || "خطأ" }));
    }
  };

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

              {/* Queue: paste the generated 9:16 video URL → schedules a Reel row
                  (pending approval on /social); the cron publishes it at its slot. */}
              {qstate[it.index] === "done" ? (
                <p className="mt-2 rounded-lg bg-emerald-50 px-2 py-1.5 text-[11px] font-semibold text-emerald-800">
                  ✅ {L("تمت الجدولة — اعتمده من صفحة السوشال ثم ينشر تلقائيًا بوقته", "Queued — approve on /social, then it auto-publishes at its slot")}
                </p>
              ) : (
                <div className="mt-2 space-y-1.5">
                  {/* Auto-generate the video in-system, or paste a URL manually. */}
                  <div className="flex flex-wrap items-center gap-2">
                    <button onClick={() => generate(it)} disabled={gen[it.index] === "working"}
                      className="shrink-0 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">
                      {gen[it.index] === "working" ? `⏳ ${L("يولّد… (دقائق)", "generating… (min)")}` : `🎬 ${L("ولّد الفيديو تلقائيًا", "Auto-generate video")}`}
                    </button>
                    <span className="text-[11px] text-muted">{L("أو الصق رابطًا يدويًا ↓", "or paste a URL below ↓")}</span>
                    {genErr[it.index] ? <span className="w-full text-[11px] text-red-600">{genErr[it.index]}</span> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input value={vurl[it.index] ?? ""} onChange={(e) => setVurl((s) => ({ ...s, [it.index]: e.target.value }))}
                      dir="ltr" placeholder={L("رابط الفيديو 9:16 (mp4)", "9:16 video URL (mp4)")}
                      className="input min-w-0 flex-1 py-1 text-xs" />
                    <button onClick={() => queue(it)} disabled={qstate[it.index] === "busy"}
                      className="btn-primary shrink-0 px-3 py-1.5 text-xs disabled:opacity-50">
                      {qstate[it.index] === "busy" ? "…" : `📅 ${L("جدولة", "Queue")}`}
                    </button>
                    {qerr[it.index] ? <span className="w-full text-[11px] text-red-600">{qerr[it.index]}</span> : null}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="py-6 text-center text-sm text-muted">{L("اضغط «ابنِ خطة الأسبوع» لتوليد ١٤ ريل مجدولة بالبرومبتات.", "Tap “Build the week” to generate 14 scheduled Reels with prompts.")}</p>
      )}
    </div>
  );
}
