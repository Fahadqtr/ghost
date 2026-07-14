"use client";

import { useState } from "react";
import {
  draftVoiceScript, refineGulfScript, generateVoicePreview,
  auditionVoices, suggestGulfVoices, type VoiceStatus,
} from "@/app/(app)/studio/voice-actions";
import { AUDITION_TEST_LINE, GULF_VOICE_BRIEF, type VoiceCandidate, type AuditionResult } from "@/lib/voice/voice-compute";
import type { Locale } from "@/lib/i18n";

// Voice Engine: (1) script → Gulf dialect → voice preview, and (2) a Voice
// Audition to compare candidate voice ids on the same line and pick the brand
// voice. ElevenLabs only; the dialect must come from a native Gulf voice.
export default function StudioVoiceEngine({ locale = "ar", initialStatus }: { locale?: Locale; initialStatus: VoiceStatus }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const connected = initialStatus.state === "connected";

  const [topic, setTopic] = useState("");
  const [script, setScript] = useState("");
  const [busy, setBusy] = useState<"" | "draft" | "refine" | "voice">("");
  const [err, setErr] = useState("");
  const [audioUrl, setAudioUrl] = useState("");

  // Audition state
  const [auditText, setAuditText] = useState(AUDITION_TEST_LINE);
  const [vids, setVids] = useState<string[]>(["", "", ""]);
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditErr, setAuditErr] = useState("");
  const [results, setResults] = useState<AuditionResult[]>([]);
  const [sugBusy, setSugBusy] = useState(false);
  const [sugErr, setSugErr] = useState("");
  const [suggestions, setSuggestions] = useState<VoiceCandidate[]>([]);

  const badge = {
    connected: { ar: "متصل", en: "Connected", cls: "bg-emerald-100 text-emerald-700" },
    not_connected: { ar: "غير متصل", en: "Not connected", cls: "bg-slate-100 text-slate-500" },
    error: { ar: "خطأ في الاتصال", en: "Error", cls: "bg-red-100 text-red-700" },
  }[initialStatus.state];

  const draft = async () => {
    setBusy("draft"); setErr("");
    try { const r = await draftVoiceScript({ topic: topic.trim() || undefined }); if ("error" in r) setErr(r.error); else { setScript(r.script); setAudioUrl(""); } }
    finally { setBusy(""); }
  };
  const refine = async () => {
    if (!script.trim()) { setErr(L("اكتب سكربت أول", "Write a script first")); return; }
    setBusy("refine"); setErr("");
    try { const r = await refineGulfScript(script); if ("error" in r) setErr(r.error); else { setScript(r.script); setAudioUrl(""); } }
    finally { setBusy(""); }
  };
  const generate = async () => {
    if (!script.trim()) { setErr(L("اكتب سكربت أول", "Write a script first")); return; }
    setBusy("voice"); setErr(""); setAudioUrl("");
    try { const r = await generateVoicePreview({ text: script }); if ("error" in r) setErr(r.error); else setAudioUrl(r.audioUrl); }
    finally { setBusy(""); }
  };

  const runAudition = async () => {
    const chosen = vids.map((v) => v.trim()).filter(Boolean);
    if (!chosen.length) { setAuditErr(L("أدخل Voice ID واحد على الأقل", "Enter at least one Voice ID")); return; }
    setAuditBusy(true); setAuditErr(""); setResults([]);
    try { const r = await auditionVoices({ text: auditText, voiceIds: vids }); if ("error" in r) setAuditErr(r.error); else setResults(r.results); }
    finally { setAuditBusy(false); }
  };
  const loadSuggestions = async () => {
    setSugBusy(true); setSugErr(""); setSuggestions([]);
    try { const r = await suggestGulfVoices(); if ("error" in r) setSugErr(r.error); else setSuggestions(r.voices); }
    finally { setSugBusy(false); }
  };
  const applyCandidate = (id: string) => setVids((cur) => {
    if (cur.includes(id)) return cur;
    const i = cur.findIndex((v) => !v.trim());
    if (i === -1) { const n = [...cur]; n[n.length - 1] = id; return n; }
    const n = [...cur]; n[i] = id; return n;
  });
  const setVid = (i: number, v: string) => setVids((cur) => { const n = [...cur]; n[i] = v; return n; });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <a href="/studio" className="btn-ghost px-2 py-1 text-xs">← {L("الاستوديو", "Studio")}</a>
        <span className="text-2xl">🔊</span>
        <h2 className="text-lg font-semibold text-ink">{L("محرك الصوت", "Voice Engine")}</h2>
        <span className={`badge ${badge.cls}`}>{en ? badge.en : badge.ar}</span>
      </div>

      {/* Connection */}
      <div className="card space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-sm font-bold text-ink">{L("حالة الاتصال", "Connection")} — ElevenLabs</span>
          <span className={`badge ${badge.cls}`}>{en ? badge.en : badge.ar}</span>
        </div>
        {initialStatus.voiceId ? <p className="text-[11px] text-muted" dir="ltr">{L("الصوت الحالي", "Current voice")}: {initialStatus.voiceId} · {initialStatus.model}</p> : null}
        {!connected && initialStatus.detail ? <p className="text-[11px] text-amber-700">{initialStatus.detail}</p> : null}
        {!connected ? <p className="text-[11px] text-muted" dir="ltr">Set <code>ELEVENLABS_API_KEY</code> + <code>ELEVENLABS_VOICE_ID</code> in Vercel, then Redeploy.</p> : null}
      </div>

      {/* Voice Audition — compare candidate voices, then adopt the winner via env. */}
      <div className="card space-y-3 border-violet-200 bg-violet-50/40">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-bold text-violet-800">🎤 {L("مقارنة الأصوات (Audition)", "Voice Audition")}</span>
        </div>
        <p className="text-[11px] text-violet-900">{L("جرّب نفس الجملة بـ ٣ أصوات مرشحة واختَر الأنسب. اللهجة لازم تجي من صوت خليجي أصلي — لا نُجبر صوتًا غير خليجي.", "Try the same line with 3 candidate voices and pick the best. The dialect must come from a native Gulf voice — we don't force a non-Gulf voice to fake it.")}</p>
        <div className="flex flex-wrap gap-1">
          {GULF_VOICE_BRIEF.map((t) => <span key={t} className="rounded-full bg-white px-2 py-0.5 text-[10px] text-violet-700 ring-1 ring-violet-200" dir="ltr">{t}</span>)}
        </div>

        {/* Test line */}
        <div className="space-y-1">
          <label className="text-[11px] font-bold text-violet-800">{L("جملة الاختبار", "Test line")}</label>
          <textarea value={auditText} onChange={(e) => setAuditText(e.target.value)} rows={2} dir="rtl"
            className="w-full rounded-lg border border-violet-200 bg-white px-3 py-2 text-sm leading-loose" />
        </div>

        {/* Candidate voice ids */}
        <div className="space-y-2">
          <label className="text-[11px] font-bold text-violet-800">{L("٣ Voice IDs مرشحة", "3 candidate Voice IDs")}</label>
          {vids.map((v, i) => (
            <input key={i} value={v} onChange={(e) => setVid(i, e.target.value)} dir="ltr"
              placeholder={`Voice ID ${i + 1}`}
              className="w-full rounded-lg border border-violet-200 bg-white px-3 py-1.5 font-mono text-xs" />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button onClick={runAudition} disabled={auditBusy || !connected}
            className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50">
            {auditBusy ? `⏳ ${L("يولّد…", "generating…")}` : `🔊 ${L("ولّد ٣ للمقارنة", "Generate 3 to compare")}`}
          </button>
          <button onClick={loadSuggestions} disabled={sugBusy || !connected}
            className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-50">
            {sugBusy ? L("…يبحث", "…searching") : `🔎 ${L("اقتراح أصوات خليجية", "Suggest Gulf voices")}`}
          </button>
          {!connected ? <span className="text-[11px] text-muted">{L("فعّل ElevenLabs أولًا", "Connect ElevenLabs first")}</span> : null}
        </div>
        {auditErr ? <p className="rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-700">{auditErr}</p> : null}

        {/* Suggestions from the ElevenLabs library */}
        {sugErr ? <p className="rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-700">{sugErr}</p> : null}
        {suggestions.length ? (
          <div className="space-y-2">
            <p className="text-[11px] font-bold text-violet-800">{L("مرشّحات من مكتبة ElevenLabs (خليجي أولًا):", "Candidates from the ElevenLabs library (Gulf first):")}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {suggestions.map((c) => (
                <div key={c.voiceId} className="space-y-1 rounded-lg border border-violet-200 bg-white p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-semibold text-ink">{c.name}{c.accent ? ` · ${c.accent}` : ""}</span>
                    <button onClick={() => applyCandidate(c.voiceId)} className="btn-ghost px-2 py-0.5 text-[10px]">{L("استخدم", "Use")}</button>
                  </div>
                  {c.previewUrl ? <audio src={c.previewUrl} controls className="h-8 w-full" /> : null}
                  <p className="truncate font-mono text-[10px] text-muted" dir="ltr">{c.voiceId}</p>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Audition results */}
        {results.length ? (
          <div className="space-y-2">
            <p className="text-[11px] font-bold text-violet-800">{L("النتائج — قارن واختَر:", "Results — compare and pick:")}</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {results.map((r) => (
                <div key={r.voiceId} className="space-y-1 rounded-lg border border-violet-200 bg-white p-2">
                  <p className="truncate font-mono text-[10px] text-muted" dir="ltr">{r.voiceId}</p>
                  {r.audioUrl ? <audio src={r.audioUrl} controls className="h-8 w-full" /> : <p className="text-[10px] text-red-600">{r.error}</p>}
                </div>
              ))}
            </div>
            <p className="text-[11px] text-violet-900">{L("عجبك صوت؟ حطّ الـ Voice ID حقه في", "Like a voice? Set its Voice ID as")} <code dir="ltr">ELEVENLABS_VOICE_ID</code> {L("في Vercel ثم Redeploy — يصير صوت البراند الثابت.", "in Vercel then Redeploy — it becomes the fixed brand voice.")}</p>
          </div>
        ) : null}
      </div>

      {/* ── Script → voice preview (uses the current brand voice) ── */}
      <p className="text-sm text-muted">{L("أو اكتب سكربت كامل، حوّله للهجة خليجية، وولّد الصوت بالصوت المعتمد.", "Or write a full script, convert to Gulf, and generate with the adopted voice.")}</p>

      <div className="card space-y-2">
        <p className="text-sm font-bold text-ink">١) {L("السكربت", "Script")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <input value={topic} onChange={(e) => setTopic(e.target.value)}
            placeholder={L("الموضوع (اختياري): مثلاً خصم رمضان", "Topic (optional): e.g. Ramadan offer")}
            className="min-w-[12rem] flex-1 rounded-lg border border-[#efe3d6] px-3 py-1.5 text-sm" />
          <button onClick={draft} disabled={!!busy} className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-50">
            {busy === "draft" ? L("…يكتب", "…writing") : `✍️ ${L("اكتب لي سكربت", "Write me a script")}`}
          </button>
        </div>
        <textarea value={script} onChange={(e) => { setScript(e.target.value); setAudioUrl(""); }} rows={5} dir="rtl"
          placeholder={L("اكتب السكربت هنا أو استخدم زر «اكتب لي سكربت»…", "Type the script here, or use “Write me a script”…")}
          className="w-full rounded-lg border border-[#efe3d6] px-3 py-2 text-sm leading-loose" />
      </div>

      <div className="card space-y-2">
        <p className="text-sm font-bold text-ink">٢) {L("اللهجة الخليجية والنطق", "Gulf dialect & pronunciation")}</p>
        <button onClick={refine} disabled={!!busy || !script.trim()} className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-50">
          {busy === "refine" ? L("…يحوّل", "…refining") : `🗣️ ${L("حوّل للهجة خليجية وحسّن النطق", "To Gulf dialect + fix pronunciation")}`}
        </button>
      </div>

      <div className="card space-y-2">
        <p className="text-sm font-bold text-ink">٣) {L("توليد الصوت", "Generate voice")}</p>
        <button onClick={generate} disabled={!!busy || !script.trim() || !connected} className="btn-primary px-4 py-1.5 text-sm disabled:opacity-50">
          {busy === "voice" ? `⏳ ${L("يولّد الصوت…", "generating…")}` : `🔊 ${L("ولّد الصوت", "Generate voice")}`}
        </button>
        {err ? <p className="rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-700">{err}</p> : null}
      </div>

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
