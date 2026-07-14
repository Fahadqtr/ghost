"use client";

import { useState } from "react";
import {
  prepareFinalReel, composeFinalReel, pollFinalReel, saveStudioReel, draftReelScript,
  type ReelPrepared,
} from "@/app/(app)/studio/reel-actions";
import {
  LOGO_POSITIONS, DEFAULT_LOGO_POSITION, DEFAULT_CTA, type CaptionLanguage,
} from "@/lib/studio/caption-compute";
import type { LogoPosition, ReelQA } from "@/lib/social/compose-compute";
import type { Locale } from "@/lib/i18n";

type Phase = "idle" | "preparing" | "preview" | "composing" | "ready" | "error";

// Final Reel Composer: FLORA video + brand voice → timed Arabic captions + logo
// + CTA + (optional ducked) music → Instagram-ready 1080×1920 mp4 (Creatomate).
export default function StudioReelComposer({ locale = "ar", status }: {
  locale?: Locale;
  status: { creatomate: boolean; logo: boolean; music: boolean };
}) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);

  const [videoUrlsText, setVideoUrlsText] = useState("");
  const [script, setScript] = useState("");
  const [language, setLanguage] = useState<CaptionLanguage>("ar");
  const [cta, setCta] = useState(DEFAULT_CTA);
  const [logoPosition, setLogoPosition] = useState<LogoPosition>(DEFAULT_LOGO_POSITION);
  const [showLogo, setShowLogo] = useState(true);
  const [productName, setProductName] = useState("");
  const [productDescription, setProductDescription] = useState("");
  const [handle, setHandle] = useState("");
  const [useMusic, setUseMusic] = useState(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [step, setStep] = useState("");
  const [err, setErr] = useState("");
  const [scriptBusy, setScriptBusy] = useState(false);
  const [prepared, setPrepared] = useState<ReelPrepared | null>(null);
  const [finalUrl, setFinalUrl] = useState("");
  const [qa, setQa] = useState<ReelQA | null>(null);
  const [saved, setSaved] = useState("");

  const videoUrls = () => videoUrlsText.split(/[\n,]+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
  const settings = () => ({ videoUrl: videoUrls()[0] || "", videoUrls: videoUrls(), script, language, cta, logoPosition, showLogo, productName, productDescription, handle, useMusic });

  const genScript = async () => {
    setScriptBusy(true); setErr("");
    const r = await draftReelScript(productName, productDescription);
    setScriptBusy(false);
    if ("error" in r) { setErr(r.error); return; }
    setScript(r.script);
  };

  const prepare = async () => {
    setPhase("preparing"); setErr(""); setFinalUrl(""); setPrepared(null); setSaved(""); setQa(null);
    setStep(L("يجهّز الصوت والكابشن…", "Preparing voice & captions…"));
    const r = await prepareFinalReel(settings());
    if ("error" in r) { setPhase("error"); setErr(r.error); return; }
    setPrepared(r); setPhase("preview");
  };

  const compose = async () => {
    if (!prepared) return;
    setPhase("composing"); setErr(""); setQa(null);
    setStep(L("يضيف الشعار والكابشن…", "Adding branding & captions…"));
    const r = await composeFinalReel({ ...settings(), audioUrl: prepared.audioUrl, durationSec: prepared.durationSec, cues: prepared.cues, brandLine: prepared.brandLine });
    if ("error" in r) { setPhase("error"); setErr(r.error); if (r.qa) setQa(r.qa); return; }
    if (r.url) { setFinalUrl(r.url); setQa(r.qa ?? null); setPhase("ready"); void save(r.url); return; }
    const renderId = r.renderId!;
    setStep(L("يمزج الصوت ويصدّر…", "Mixing audio & exporting…"));
    let attempts = 0;
    const tick = async () => {
      attempts++;
      const p = await pollFinalReel(renderId, prepared.durationSec);
      if ("error" in p) { setPhase("error"); setErr(p.error); return; }
      if (p.url) { setFinalUrl(p.url); setQa(p.qa ?? null); setPhase("ready"); void save(p.url); return; }
      if (attempts > 60) { setPhase("error"); setErr(L("طال وقت التصدير — جرّب مرة ثانية", "Export timed out — try again")); return; }
      setTimeout(tick, 5000);
    };
    setTimeout(tick, 5000);
  };

  const save = async (url: string) => {
    const r = await saveStudioReel({
      videoUrl: url, productName, script, language,
      captionSettings: { language }, logoSettings: { position: logoPosition, show: showLogo }, cta,
    });
    setSaved(r.ok ? L("✔ حُفظ في المكتبة", "✔ saved to library") : (r.error || ""));
  };

  const busy = phase === "preparing" || phase === "composing";
  const STEPS = [
    { k: "preparing", ar: "التجهيز", en: "Preparing" },
    { k: "captions", ar: "الكابشن", en: "Captions" },
    { k: "branding", ar: "الشعار والـCTA", en: "Branding" },
    { k: "mixing", ar: "مزج الصوت", en: "Mixing audio" },
    { k: "exporting", ar: "التصدير", en: "Exporting" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <a href="/studio" className="btn-ghost px-2 py-1 text-xs">← {L("الاستوديو", "Studio")}</a>
        <span className="text-2xl">🎞️</span>
        <h2 className="text-lg font-semibold text-ink">{L("إنشاء الريل النهائي", "Final Reel Composer")}</h2>
      </div>
      <p className="text-sm text-muted">{L("فيديو FLORA + صوت البراند → كابشن عربي + شعار + CTA + موسيقى → ريل جاهز لإنستغرام (1080×1920).", "FLORA video + brand voice → Arabic captions + logo + CTA + music → Instagram-ready reel (1080×1920).")}</p>

      {!status.creatomate ? (
        <div className="card border-amber-200 bg-amber-50/40">
          <p className="text-[11px] text-amber-800" dir="ltr">Set <code>CREATOMATE_API_KEY</code> (+ <code>MALIKA_LOGO_URL</code>, <code>REELS_MUSIC_URL</code>) in Vercel, then Redeploy.</p>
        </div>
      ) : null}

      {/* Inputs */}
      <div className="card space-y-3">
        <div className="space-y-1">
          <label className="text-xs font-bold text-ink">{L("روابط لقطات FLORA (كل رابط بسطر)", "FLORA shot URLs (one per line)")}</label>
          <textarea value={videoUrlsText} onChange={(e) => setVideoUrlsText(e.target.value)} rows={3} dir="ltr" placeholder={"https://media.flora.ai/shot1…\nhttps://media.flora.ai/shot2…"}
            className="w-full rounded-lg border border-[#efe3d6] px-3 py-1.5 font-mono text-[11px] leading-relaxed" />
          <p className="text-[10px] text-muted">{L("لقطتان أو ثلاث أفضل — تُرتّب تلقائياً حسب مدة الصوت بدل تكرار لقطة واحدة.", "2–3 shots is best — they're sequenced to the voice length instead of looping one clip.")}</p>
        </div>
        {/* Product-aware script: name + description → tailored Gulf script. */}
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1"><span className="text-xs font-bold text-ink">{L("اسم المنتج", "Product name")}</span>
            <input value={productName} onChange={(e) => setProductName(e.target.value)} dir="rtl" className="w-full rounded-lg border border-[#efe3d6] px-3 py-1.5 text-sm" />
          </label>
          <label className="space-y-1"><span className="text-xs font-bold text-ink">{L("وصف المنتج", "Product description")}</span>
            <input value={productDescription} onChange={(e) => setProductDescription(e.target.value)} dir="rtl" placeholder={L("مكوّناته وفائدته…", "ingredients & benefit…")} className="w-full rounded-lg border border-[#efe3d6] px-3 py-1.5 text-sm" />
          </label>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold text-ink">{L("السكربت (خليجي)", "Script (Gulf)")}</label>
            <button onClick={genScript} disabled={scriptBusy || (!productName.trim() && !productDescription.trim())}
              className="btn-ghost px-2 py-0.5 text-[11px] disabled:opacity-50">
              {scriptBusy ? `⏳ ${L("يكتب…", "Writing…")}` : `✨ ${L("اكتب السكربت من المنتج", "Write script from product")}`}
            </button>
          </div>
          <textarea value={script} onChange={(e) => setScript(e.target.value)} rows={4} dir="rtl"
            placeholder={L("اكتب السكربت أو ولّده من اسم/وصف المنتج فوق…", "Write it or generate from the product name/description above…")}
            className="w-full rounded-lg border border-[#efe3d6] px-3 py-2 text-sm leading-loose" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1"><span className="text-xs font-bold text-ink">{L("لغة الكابشن", "Caption language")}</span>
            <select value={language} onChange={(e) => setLanguage(e.target.value as CaptionLanguage)} className="w-full rounded-lg border border-[#efe3d6] px-3 py-1.5 text-sm">
              <option value="ar">{L("عربي فقط", "Arabic only")}</option>
              <option value="en">{L("إنجليزي فقط", "English only")}</option>
              <option value="ar_en">{L("عربي + إنجليزي", "Arabic + English")}</option>
            </select>
          </label>
          <label className="space-y-1"><span className="text-xs font-bold text-ink">{L("موضع الشعار", "Logo position")}</span>
            <select value={logoPosition} onChange={(e) => setLogoPosition(e.target.value as LogoPosition)} className="w-full rounded-lg border border-[#efe3d6] px-3 py-1.5 text-sm">
              {LOGO_POSITIONS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="space-y-1"><span className="text-xs font-bold text-ink">CTA</span>
            <input value={cta} onChange={(e) => setCta(e.target.value)} dir="rtl" className="w-full rounded-lg border border-[#efe3d6] px-3 py-1.5 text-sm" />
          </label>
          <label className="space-y-1"><span className="text-xs font-bold text-ink">{L("حساب/موقع (اختياري)", "Handle / site (optional)")}</span>
            <input value={handle} onChange={(e) => setHandle(e.target.value)} dir="ltr" placeholder="@malikasuniverse" className="w-full rounded-lg border border-[#efe3d6] px-3 py-1.5 text-sm" />
          </label>
          <div className="flex items-end gap-4 pb-1">
            <label className="flex items-center gap-1 text-xs text-ink"><input type="checkbox" checked={showLogo} onChange={(e) => setShowLogo(e.target.checked)} /> {L("الشعار", "Logo")}</label>
            <label className="flex items-center gap-1 text-xs text-ink"><input type="checkbox" checked={useMusic} onChange={(e) => setUseMusic(e.target.checked)} /> {L("موسيقى", "Music")}</label>
          </div>
        </div>
        <button onClick={prepare} disabled={busy || !status.creatomate || !videoUrls().length || (!script.trim() && !productName.trim() && !productDescription.trim())}
          className="btn-ghost px-4 py-1.5 text-sm disabled:opacity-50">
          {phase === "preparing" ? `⏳ ${step}` : `١) ${L("جهّز المعاينة", "Prepare preview")}`}
        </button>
        {err ? <p className="rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-700">{err}</p> : null}
      </div>

      {/* Preview */}
      {prepared ? (
        <div className="card space-y-3 border-violet-200 bg-violet-50/40">
          <p className="text-sm font-bold text-violet-800">👁️ {L("معاينة قبل التصدير", "Preview before export")}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <p className="text-[11px] font-bold text-violet-800">{L("لقطات FLORA", "FLORA shots")} ({videoUrls().length})</p>
              <video src={videoUrls()[0]} controls className="w-full rounded-lg" />
            </div>
            <div className="space-y-2">
              <p className="text-[11px] font-bold text-violet-800">{L("الصوت", "Voice")}</p>
              <audio src={prepared.audioUrl} controls className="w-full" />
              <p className="text-[11px] font-bold text-violet-800">
                {L("الكابشن", "Captions")} {prepared.syncedToVoice ? <span className="text-emerald-600">· {L("متزامن مع الصوت", "voice-synced")}</span> : <span className="text-amber-600">· {L("توقيت تقديري", "estimated timing")}</span>}
              </p>
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg bg-white p-2 text-[11px]" dir="auto">
                {prepared.cues.map((c, i) => (
                  <p key={i} className="flex items-start gap-2 whitespace-pre-line border-b border-[#f2ead9] pb-1 last:border-0">
                    <span className="shrink-0 font-mono text-[9px] text-violet-400">{c.time.toFixed(1)}s</span>
                    <span>{c.text}</span>
                  </p>
                ))}
              </div>
            </div>
          </div>
          {/* Duration sync — voice length drives the reel; the FLORA shots are
              sequenced to fill it (no unnatural stretching). */}
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-white/70 px-2 py-1.5">
              <p className="text-[10px] text-violet-500">{L("اللقطات", "Shots")}</p>
              <p className="text-xs font-bold text-violet-900">{videoUrls().length > 1 ? L(`${videoUrls().length} متسلسلة`, `${videoUrls().length} seq`) : L("حلقة", "loop")}</p>
            </div>
            <div className="rounded-lg bg-white/70 px-2 py-1.5">
              <p className="text-[10px] text-violet-500">{L("الصوت", "Voice")}</p>
              <p className="text-xs font-bold text-violet-900">{prepared.durationSec ? `${prepared.durationSec.toFixed(1)}s` : "auto"}</p>
            </div>
            <div className="rounded-lg bg-white/70 px-2 py-1.5">
              <p className="text-[10px] text-violet-500">{L("الريل النهائي", "Final")}</p>
              <p className="text-xs font-bold text-violet-900">{prepared.finalDurationSec.toFixed(1)}s</p>
            </div>
          </div>
          <p className="text-[11px] text-violet-900">
            {L("الشعار:", "Logo:")} {showLogo ? logoPosition : L("مخفي", "off")} · CTA: {cta || DEFAULT_CTA} · {L("موسيقى:", "Music:")} {useMusic ? "on" : "off"} · 1080×1920
            {prepared.brandLine ? ` · ${prepared.brandLine}` : ""}
          </p>
          <button onClick={compose} disabled={busy} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
            {phase === "composing" ? `⏳ ${step}` : `🎞️ ${L("إنشاء الريل النهائي", "Generate Final Reel")}`}
          </button>
        </div>
      ) : null}

      {/* Progress */}
      {phase === "composing" ? (
        <div className="card space-y-1">
          <div className="flex flex-wrap gap-2">
            {STEPS.map((s) => <span key={s.k} className="badge bg-slate-100 text-slate-600">{en ? s.en : s.ar}</span>)}
          </div>
          <p className="text-[11px] text-muted">{step}</p>
        </div>
      ) : null}

      {/* QA (also shown on a failed export) */}
      {qa ? (
        <div className={`card space-y-1 ${qa.pass ? "border-emerald-200 bg-emerald-50/40" : "border-red-200 bg-red-50/40"}`}>
          <p className={`text-xs font-bold ${qa.pass ? "text-emerald-800" : "text-red-800"}`}>
            {qa.pass ? `✅ ${L("فحص الجودة نجح", "Final QA passed")}` : `⚠️ ${L("فحص الجودة", "Final QA")}`}
          </p>
          <ul className="space-y-0.5">
            {qa.checks.map((c, i) => (
              <li key={i} className="flex items-center gap-2 text-[11px]">
                <span>{c.ok ? "✅" : "❌"}</span><span className="text-ink">{c.label}</span>
                <span className="text-muted">— {c.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Result */}
      {finalUrl ? (
        <div className="card space-y-2 border-emerald-200 bg-emerald-50/40">
          <p className="text-sm font-bold text-emerald-800">✅ {L("الريل جاهز", "Reel ready")} · 1080×1920 · MP4</p>
          <video src={finalUrl} controls className="w-full max-w-sm rounded-xl" />
          <div className="flex flex-wrap items-center gap-3">
            <a href={finalUrl} target="_blank" rel="noreferrer" className="btn-primary px-3 py-1.5 text-xs">⬇️ {L("تحميل", "Download")}</a>
            {saved ? <span className="text-[11px] text-emerald-700">{saved}</span> : null}
          </div>
          <a href={finalUrl} target="_blank" rel="noreferrer" dir="ltr" className="block truncate text-[11px] text-violet-700 underline">{finalUrl}</a>
        </div>
      ) : null}
    </div>
  );
}
