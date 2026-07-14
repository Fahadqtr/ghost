"use client";

import { useState } from "react";
import { draftVoiceScript, refineGulfScript, generateVoicePreview, type VoiceStatus } from "@/app/(app)/studio/voice-actions";
import type { Locale } from "@/lib/i18n";

// Voice Engine flow: write (or generate) a script → refine to natural Qatari
// Gulf + TTS-safe pronunciation → generate a voice preview → play it here.
// ElevenLabs only. Audio is not composed onto the video yet.
export default function StudioVoiceEngine({ locale = "ar", initialStatus }: { locale?: Locale; initialStatus: VoiceStatus }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);

  const connected = initialStatus.state === "connected";
  const [topic, setTopic] = useState("");
  const [script, setScript] = useState("");
  const [busy, setBusy] = useState<"" | "draft" | "refine" | "voice">("");
  const [err, setErr] = useState("");
  const [audioUrl, setAudioUrl] = useState("");

  const badge = {
    connected: { ar: "متصل", en: "Connected", cls: "bg-emerald-100 text-emerald-700" },
    not_connected: { ar: "غير متصل", en: "Not connected", cls: "bg-slate-100 text-slate-500" },
    error: { ar: "خطأ في الاتصال", en: "Error", cls: "bg-red-100 text-red-700" },
  }[initialStatus.state];

  const draft = async () => {
    setBusy("draft"); setErr("");
    try {
      const r = await draftVoiceScript({ topic: topic.trim() || undefined });
      if ("error" in r) setErr(r.error); else { setScript(r.script); setAudioUrl(""); }
    } finally { setBusy(""); }
  };
  const refine = async () => {
    if (!script.trim()) { setErr(L("اكتب سكربت أول", "Write a script first")); return; }
    setBusy("refine"); setErr("");
    try {
      const r = await refineGulfScript(script);
      if ("error" in r) setErr(r.error); else { setScript(r.script); setAudioUrl(""); }
    } finally { setBusy(""); }
  };
  const generate = async () => {
    if (!script.trim()) { setErr(L("اكتب سكربت أول", "Write a script first")); return; }
    setBusy("voice"); setErr(""); setAudioUrl("");
    try {
      const r = await generateVoicePreview({ text: script });
      if ("error" in r) setErr(r.error); else setAudioUrl(r.audioUrl);
    } finally { setBusy(""); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <a href="/studio" className="btn-ghost px-2 py-1 text-xs">← {L("الاستوديو", "Studio")}</a>
        <span className="text-2xl">🔊</span>
        <h2 className="text-lg font-semibold text-ink">{L("محرك الصوت", "Voice Engine")}</h2>
        <span className={`badge ${badge.cls}`}>{en ? badge.en : badge.ar}</span>
      </div>
      <p className="text-sm text-muted">{L("اكتب سكربت أو خلّ النظام يكتبه، حوّله للهجة خليجية طبيعية، وولّد الصوت واسمعه هنا. (ElevenLabs فقط — بدون صوت بديل).", "Write or generate a script, convert it to natural Gulf Arabic, generate the voice and hear it here. (ElevenLabs only — no fallback.)")}</p>

      {/* Connection */}
      <div className="card space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-sm font-bold text-ink">{L("حالة الاتصال", "Connection")} — ElevenLabs</span>
          <span className={`badge ${badge.cls}`}>{en ? badge.en : badge.ar}</span>
        </div>
        {initialStatus.voiceId ? <p className="text-[11px] text-muted" dir="ltr">Voice ID: {initialStatus.voiceId} · {initialStatus.model}</p> : null}
        {!connected && initialStatus.detail ? <p className="text-[11px] text-amber-700">{initialStatus.detail}</p> : null}
        {!connected ? (
          <p className="text-[11px] text-muted" dir="ltr">
            Set <code>ELEVENLABS_API_KEY</code> + <code>ELEVENLABS_VOICE_ID</code> in Vercel, then Redeploy.
          </p>
        ) : null}
      </div>

      {/* 1) Script */}
      <div className="card space-y-2">
        <p className="text-sm font-bold text-ink">١) {L("السكربت", "Script")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <input value={topic} onChange={(e) => setTopic(e.target.value)}
            placeholder={L("الموضوع (اختياري): مثلاً خصم رمضان", "Topic (optional): e.g. Ramadan offer")}
            className="min-w-[12rem] flex-1 rounded-lg border border-[#efe3d6] px-3 py-1.5 text-sm" />
          <button onClick={draft} disabled={!!busy}
            className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-50">
            {busy === "draft" ? L("…يكتب", "…writing") : `✍️ ${L("اكتب لي سكربت", "Write me a script")}`}
          </button>
        </div>
        <textarea value={script} onChange={(e) => { setScript(e.target.value); setAudioUrl(""); }} rows={5}
          dir="rtl" placeholder={L("اكتب السكربت هنا أو استخدم زر «اكتب لي سكربت»…", "Type the script here, or use “Write me a script”…")}
          className="w-full rounded-lg border border-[#efe3d6] px-3 py-2 text-sm leading-loose" />
      </div>

      {/* 2) Gulf dialect + pronunciation */}
      <div className="card space-y-2">
        <p className="text-sm font-bold text-ink">٢) {L("اللهجة الخليجية والنطق", "Gulf dialect & pronunciation")}</p>
        <button onClick={refine} disabled={!!busy || !script.trim()}
          className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-50">
          {busy === "refine" ? L("…يحوّل", "…refining") : `🗣️ ${L("حوّل للهجة خليجية وحسّن النطق", "To Gulf dialect + fix pronunciation")}`}
        </button>
      </div>

      {/* 3) Generate voice */}
      <div className="card space-y-2">
        <p className="text-sm font-bold text-ink">٣) {L("توليد الصوت", "Generate voice")}</p>
        <button onClick={generate} disabled={!!busy || !script.trim() || !connected}
          className="btn-primary px-4 py-1.5 text-sm disabled:opacity-50">
          {busy === "voice" ? `⏳ ${L("يولّد الصوت…", "generating…")}` : `🔊 ${L("ولّد الصوت", "Generate voice")}`}
        </button>
        {!connected ? <span className="ms-2 text-[11px] text-muted">{L("فعّل ElevenLabs أولًا", "Connect ElevenLabs first")}</span> : null}
        {err ? <p className="rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-700">{err}</p> : null}
      </div>

      {/* 4) Preview */}
      {audioUrl ? (
        <div className="card space-y-2">
          <p className="text-sm font-bold text-ink">✅ {L("معاينة الصوت", "Voice preview")}</p>
          <audio src={audioUrl} controls className="w-full max-w-sm" />
          <a href={audioUrl} target="_blank" rel="noreferrer" dir="ltr" className="block truncate text-[11px] text-violet-700 underline">{audioUrl}</a>
        </div>
      ) : null}
    </div>
  );
}
