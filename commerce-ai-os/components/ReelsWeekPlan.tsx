"use client";

import { useState } from "react";
import { previewReelsWeek, queueReel, generateReelVideo, pollReelVideo, finalizeReel, pollReelCompose } from "@/app/(app)/content/actions";
import type { ReelPlanItem } from "@/lib/social/reels-plan";
import { qatarDayLabel, qatarTimeLabel } from "@/lib/social/schedule-compute";
import ProductThumb from "@/components/ProductThumb";
import type { Locale } from "@/lib/i18n";

// Where Marketing Studio lives (Higgsfield app) + how to hand a product to it.
const MARKETING_STUDIO_URL = "https://higgsfield.ai/";
const STORE_DOMAIN = "malikasuniverse.com";
const productUrl = (sku: string | null) =>
  sku ? `https://${STORE_DOMAIN}/search?q=${encodeURIComponent(sku)}` : `https://${STORE_DOMAIN}`;
// Ready Arabic UGC brief to paste into Marketing Studio's prompt.
const marketingBriefAr = (name: string) =>
  `ريل UGC لمنتج «${name}». بنت خليجية في حمّام عصري بالدوحة: هوك بأول ١.٥ ثانية، تُظهر المنتج بوضوح (الليبل للكاميرا)، تفتحه وتطبّقه، تبيّن النضارة، ثم توصّي فيه. تتكلم بالعربي الخليجي. طاقة عالية، مظهر نظيف، بدون نص على الشاشة.`;
// Natural Gulf-Arabic spoken script for the ElevenLabs voiceover on the
// assembled reel — short, conversational, ends on the «اطلب الآن» CTA. Kept
// to ~3 short lines (~10–13s) so the delivery stays natural, not rushed.
const spokenAr = (name: string) =>
  `تعرفين ${name || "هذا المنتج"}؟ من أول استخدام النتيجة تبيّن، ونضارة تدوم طول اليوم. عندنا في ماليكاس يونيفرس، والتوصيل لباب بيتك في قطر. اطلبيه الحين.`;

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
  const [genPhase, setGenPhase] = useState<Record<number, string>>({});

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

  // Full pipeline, no manual steps: generate the silent product video →
  // Arabic voiceover → logo + «اطلب الآن» overlay (Creatomate) → fill the URL
  // field with the finished reel. Phase labels keep the operator informed.
  const genFull = async (it: ReelPlanItem) => {
    if (!it.sku) { setGenErr((s) => ({ ...s, [it.index]: L("لا يوجد منتج", "No product") })); return; }
    const set = (phase: string) => setGenPhase((s) => ({ ...s, [it.index]: phase }));
    setGen((s) => ({ ...s, [it.index]: "working" }));
    setGenErr((s) => ({ ...s, [it.index]: "" }));
    const fail = (msg: string) => { setGen((s) => ({ ...s, [it.index]: "error" })); setGenErr((s) => ({ ...s, [it.index]: msg })); set(""); };

    // 1) Higgsfield video from the product photo.
    set(L("١/٣ يولّد الفيديو…", "1/3 video…"));
    const r = await generateReelVideo({ sku: it.sku, prompt: it.promptEn });
    if ("error" in r) return fail(r.error);

    // 2) Poll the video, then finalize (voiceover + overlay), then poll the render.
    let vAttempts = 0;
    const waitVideo = async (): Promise<string | null> => new Promise((resolve) => {
      const tick = async () => {
        vAttempts++;
        const p = await pollReelVideo(r.requestId);
        if ("error" in p) { fail(p.error); return resolve(null); }
        if (p.videoUrl) return resolve(p.videoUrl);
        if (vAttempts > 40) { fail(L("طال وقت توليد الفيديو", "Video timed out")); return resolve(null); }
        setTimeout(tick, 15000);
      };
      setTimeout(tick, 15000);
    });
    const videoUrl = await waitVideo();
    if (!videoUrl) return;

    set(L("٢/٣ صوت عربي + لوقو + «اطلب الآن»…", "2/3 voice + logo + CTA…"));
    const f = await finalizeReel({ videoUrl, scriptAr: spokenAr(it.productName ?? ""), ctaText: "اطلب الآن 🌸" });
    if ("error" in f) return fail(f.error);
    if (f.url) { setVurl((s) => ({ ...s, [it.index]: f.url! })); setGen((s) => ({ ...s, [it.index]: "idle" })); set(""); return; }
    if (!f.renderId) return fail(L("لم يرجع رابط التركيب", "No render returned"));

    set(L("٣/٣ يركّب الريل…", "3/3 composing…"));
    let cAttempts = 0;
    const renderId = f.renderId;
    const waitCompose = async () => {
      cAttempts++;
      const p = await pollReelCompose(renderId);
      if ("error" in p) return fail(p.error);
      if (p.url) { setVurl((s) => ({ ...s, [it.index]: p.url! })); setGen((s) => ({ ...s, [it.index]: "idle" })); set(""); return; }
      if (cAttempts > 40) return fail(L("طال وقت التركيب", "Compose timed out"));
      setTimeout(waitCompose, 15000);
    };
    setTimeout(waitCompose, 15000);
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
        💡 {L("زر «ريل كامل» يسوي كل شي تلقائيًا: فيديو من صورة المنتج + صوت عربي طبيعي + لوقو ماليكاس + «اطلب الآن» على الشاشة — بدون أي تدخل. يحتاج مفاتيح ElevenLabs و Creatomate في Vercel. للـ UGC (شخص يتكلم) استخدم Marketing Studio تحت.",
          "The “Full reel” button does everything automatically: video from the product photo + natural Arabic voice + Malika logo + on-screen “Order now” — hands-off. Needs the ElevenLabs & Creatomate keys in Vercel. For UGC (a person talking) use Marketing Studio below.")}
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

              {/* Premium path: everything needed to make this reel in the Higgsfield
                  app's Marketing Studio (a talking-avatar UGC ad), then paste the URL
                  back below. Product image + product URL + a ready Arabic brief. */}
              <div className="mt-2 space-y-1.5 rounded-lg border border-violet-200 bg-violet-50/50 p-2">
                <p className="text-[11px] font-bold text-violet-800">🎬 {L("جودة عالية عبر Marketing Studio (تطبيق Higgsfield)", "Premium via Marketing Studio (Higgsfield app)")}</p>
                <div className="flex items-center gap-2">
                  <ProductThumb imageUrl={null} sku={it.sku} sizeClass="h-12 w-12" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] text-muted">{L("١) الصق رابط المنتج في «Add product»:", "1) Paste the product URL in “Add product”:")}</p>
                    <div className="flex items-center gap-1">
                      <span className="truncate text-[10px] text-slate-700" dir="ltr">{productUrl(it.sku)}</span>
                      <button onClick={() => copy(productUrl(it.sku), L("📋 نُسخ رابط المنتج", "📋 Product URL copied"))}
                        className="shrink-0 rounded bg-white px-1.5 py-0.5 text-[10px] font-bold text-violet-700 ring-1 ring-violet-200">📋</button>
                    </div>
                  </div>
                </div>
                <div className="flex items-start gap-1">
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] text-muted">{L("٢) الصق الوصفة في البرومبت:", "2) Paste the brief into the prompt:")}</p>
                    <p className="text-[10px] leading-relaxed text-slate-700">{marketingBriefAr(it.productName ?? "")}</p>
                  </div>
                  <button onClick={() => copy(marketingBriefAr(it.productName ?? ""), L("📋 نُسخت الوصفة", "📋 Brief copied"))}
                    className="shrink-0 rounded bg-white px-1.5 py-0.5 text-[10px] font-bold text-violet-700 ring-1 ring-violet-200">📋</button>
                </div>
                <p className="text-[10px] text-muted">{L("٣) الإعدادات: 9:16 · الصوت On · العربية → Generate، وبعدها الصق رابط mp4 تحت.", "3) Settings: 9:16 · Audio On · Arabic → Generate, then paste the mp4 URL below.")}</p>
                <a href={MARKETING_STUDIO_URL} target="_blank" rel="noreferrer"
                  className="inline-block rounded-md bg-violet-600 px-3 py-1.5 text-[11px] font-bold text-white">🎬 {L("افتح Marketing Studio", "Open Marketing Studio")}</a>
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
                    <button onClick={() => genFull(it)} disabled={gen[it.index] === "working"}
                      className="shrink-0 rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">
                      {gen[it.index] === "working"
                        ? `⏳ ${genPhase[it.index] || L("يشتغل…", "working…")}`
                        : `🎬✨ ${L("ريل كامل (صوت+لوقو+اطلب الآن)", "Full reel (voice+logo+CTA)")}`}
                    </button>
                    <button onClick={() => generate(it)} disabled={gen[it.index] === "working"}
                      className="shrink-0 rounded-md bg-violet-100 px-3 py-1.5 text-xs font-bold text-violet-700 disabled:opacity-50">
                      🎬 {L("فيديو فقط (بدون صوت)", "Video only (silent)")}
                    </button>
                    <span className="text-[11px] text-muted">{L("أو الصق رابط Marketing Studio ↓", "or paste a Marketing Studio URL ↓")}</span>
                    {genErr[it.index] ? <span className="w-full text-[11px] text-red-600">{genErr[it.index]}</span> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input value={vurl[it.index] ?? ""} onChange={(e) => setVurl((s) => ({ ...s, [it.index]: e.target.value }))}
                      dir="ltr" placeholder={L("رابط ريل جاهز 9:16 (Marketing Studio · mp4)", "finished 9:16 reel URL (Marketing Studio · mp4)")}
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
