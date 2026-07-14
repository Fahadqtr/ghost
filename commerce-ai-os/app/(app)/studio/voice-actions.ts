"use server";

import Anthropic from "@anthropic-ai/sdk";
import { requireUser } from "@/lib/auth/requireUser";
import { synthArabicVoice, elevenStatus, elevenVoiceId, elevenModelId, listGulfVoiceCandidates, type VoiceConnState, type VoiceDebug } from "@/lib/social/voiceover";
import { buildGulfScriptPrompt, buildGulfDialectPrompt, buildGulfRewriteOnlyPrompt, cleanScriptLines, normalizeVoiceIds, addNaturalPauses, AUDITION_TEST_LINE, type VoiceCandidate, type AuditionResult } from "@/lib/voice/voice-compute";

// Malika AI Studio → Voice Engine (phase 3). ElevenLabs is the ONLY voice
// provider (no generic-Arabic fallback). Flow: write/generate a script → refine
// to natural Qatari Gulf + TTS-safe pronunciation → generate a voice preview and
// play it in /studio. Audio is NOT composed onto the final video yet.

async function claude(prompt: string, maxTokens = 500): Promise<{ error: string } | { text: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: "ANTHROPIC_API_KEY غير مهيأ على الخادم." };
  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: process.env.STAFF_MALAK_MODEL || "claude-sonnet-4-6",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    return { text };
  } catch (e: any) {
    return { error: `فشل الاتصال بـ Claude: ${e?.message ?? "خطأ"}` };
  }
}

export interface VoiceStatus { state: VoiceConnState; detail?: string; voiceId: string; model: string }

/** Live ElevenLabs connection status for the Voice Engine + settings pages. */
export async function voiceEngineStatus(): Promise<VoiceStatus> {
  await requireUser();
  const s = await elevenStatus();
  return { state: s.state, detail: s.detail, voiceId: s.voiceId || elevenVoiceId(), model: s.model || elevenModelId() };
}

/** Let the system write a Gulf voiceover script from a topic and/or product. */
export async function draftVoiceScript(input: { topic?: string; productName?: string }): Promise<{ error: string } | { script: string }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const r = await claude(buildGulfScriptPrompt(input));
  if ("error" in r) return r;
  const script = cleanScriptLines(r.text);
  if (!script) return { error: "ما قدرت أكتب السكربت — جرّب مرة ثانية." };
  return { script };
}

/**
 * Rewrite a script into natural Qatari Gulf — NO tashkeel. The Voice Debug
 * showed the rewrite-only (no-tashkeel) text renders a truer Gulf accent than
 * the tashkeel'd variant, so the studio refine uses the plain Gulf rewrite.
 */
export async function refineGulfScript(script: string): Promise<{ error: string } | { script: string }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const s = String(script || "").trim();
  if (!s) return { error: "اكتب سكربت أول." };
  const r = await claude(buildGulfRewriteOnlyPrompt(s));
  if ("error" in r) return r;
  const refined = cleanScriptLines(r.text);
  if (!refined) return { error: "ما قدرت أحسّن النص — جرّب مرة ثانية." };
  return { script: refined };
}

/** Generate a voice preview (mp3) from the final text — ElevenLabs only, no fallback. */
export async function generateVoicePreview(input: { text: string; voiceId?: string }): Promise<{ error: string } | { audioUrl: string; durationSec?: number }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const text = String(input.text || "").trim();
  if (!text) return { error: "لا يوجد نص للصوت." };
  const voiceId = String(input.voiceId || "").trim() || undefined;
  const r = await synthArabicVoice(text, voiceId ? { voiceId } : undefined);
  if (!r.ok || !r.url) return { error: r.error || "فشل توليد الصوت." };
  return { audioUrl: r.url, durationSec: r.durationSec };
}

/**
 * Voice Audition: synth the SAME line with the candidate voice ids (up to 12) so
 * the owner can compare and pick. Slightly more expressive settings (lower
 * stability, higher style) to avoid a flat read. Runs in small concurrent chunks
 * to respect ElevenLabs limits. Nothing is adopted automatically.
 */
export async function auditionVoices(input: { text: string; voiceIds: string[] }): Promise<{ error: string } | { results: AuditionResult[] }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const text = String(input.text || "").trim();
  if (!text) return { error: "لا يوجد نص للاختبار." };
  const ids = normalizeVoiceIds(input.voiceIds, 12);
  if (!ids.length) return { error: "أدخل Voice ID واحد على الأقل." };
  const results: AuditionResult[] = [];
  for (let i = 0; i < ids.length; i += 3) {
    const part = await Promise.all(ids.slice(i, i + 3).map(async (voiceId): Promise<AuditionResult> => {
      const r = await synthArabicVoice(text, { voiceId, stability: 0.3, style: 0.45 });
      return r.ok && r.url ? { voiceId, audioUrl: r.url } : { voiceId, error: r.error || "فشل التوليد." };
    }));
    results.push(...part);
  }
  return { results };
}

/** Suggest native Gulf female voices from the ElevenLabs library to audition. */
export async function suggestGulfVoices(): Promise<{ error: string } | { voices: VoiceCandidate[] }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const r = await listGulfVoiceCandidates();
  if (!r.ok) return { error: r.error || "تعذّر جلب الأصوات." };
  return { voices: r.voices };
}

export interface ABClip { label: string; settings: { stability: number; style: number; speed: number }; text: string; audioUrl?: string; error?: string; debug?: VoiceDebug }

/**
 * Final A/B on the brand voice (voice id + model + text mode unchanged):
 * A = current settings; B = the proposed settings (stability 0.45, style 0.20,
 * speed 0.96) + natural pauses (no tashkeel). Same voice + line for both.
 */
export async function voiceAB(input: { voiceId: string; text?: string }): Promise<{ error: string } | { a: ABClip; b: ABClip }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const voiceId = String(input.voiceId || "").trim();
  if (!voiceId) return { error: "أدخل Voice ID." };
  const base = String(input.text || "").trim() || AUDITION_TEST_LINE;

  const aSettings = { stability: 0.4, style: 0.35, speed: 1.0 };
  const bSettings = { stability: 0.45, style: 0.20, speed: 0.96 };
  const bText = addNaturalPauses(base); // only B gets natural pauses

  const [ra, rb] = await Promise.all([
    synthArabicVoice(base, { voiceId, ...aSettings }),
    synthArabicVoice(bText, { voiceId, ...bSettings }),
  ]);
  return {
    a: { label: "A · الإعداد الحالي", settings: aSettings, text: base, audioUrl: ra.url, error: ra.ok ? undefined : ra.error, debug: ra.debug },
    b: { label: "B · الإعدادات الجديدة + وقفات", settings: bSettings, text: bText, audioUrl: rb.url, error: rb.ok ? undefined : rb.error, debug: rb.debug },
  };
}

export interface DebugClip { label: string; variant: "raw" | "rewrite" | "normalized"; model: string; text: string; audioUrl?: string; error?: string; debug?: VoiceDebug }
export interface VoiceDebugReport {
  selectedVoiceId: string;
  texts: { original: string; rewritten: string; normalized: string };
  settings: { stability: number; style: number; similarity: number; speakerBoost: boolean; languageCode: null };
  clips: DebugClip[];
}

/**
 * Voice Debug: prove WHY the library preview is right but our TTS is off. Same
 * voice id + line, across a matrix — text variant (A raw / B rewrite+tashkeel /
 * C rewrite-only) × model (eleven_multilingual_v2, eleven_v3) — with FIXED
 * neutral settings (close to the library preview) and NO language_code. All
 * automatic dialect/MSA/phonetic behaviour is off for RAW. Nothing is adopted.
 */
export async function voiceDebug(input: { voiceId: string; text?: string }): Promise<{ error: string } | VoiceDebugReport> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const voiceId = String(input.voiceId || "").trim();
  if (!voiceId) return { error: "أدخل Voice ID." };
  const original = String(input.text || "").trim() || AUDITION_TEST_LINE;

  // B = current pipeline (Gulf rewrite + light tashkeel); C = rewrite only (no tashkeel).
  const bRes = await claude(buildGulfDialectPrompt(original));
  const cRes = await claude(buildGulfRewriteOnlyPrompt(original));
  const normalized = "error" in bRes ? original : (cleanScriptLines(bRes.text) || original);
  const rewritten = "error" in cRes ? original : (cleanScriptLines(cRes.text) || original);

  // Neutral settings that mimic the ElevenLabs library preview (isolate text+model).
  const settings = { stability: 0.5, style: 0, similarity: 0.75, speakerBoost: true, languageCode: null } as const;
  const variants: { label: string; variant: DebugClip["variant"]; text: string }[] = [
    { label: "A · RAW (no rewrite/normalize)", variant: "raw", text: original },
    { label: "B · rewrite + tashkeel (current)", variant: "normalized", text: normalized },
    { label: "C · rewrite only (no tashkeel)", variant: "rewrite", text: rewritten },
  ];
  const models = ["eleven_multilingual_v2", "eleven_v3"];

  const clips: DebugClip[] = [];
  for (const m of models) {
    // one model at a time; variants concurrently (3) to respect limits
    const part = await Promise.all(variants.map(async (v): Promise<DebugClip> => {
      const r = await synthArabicVoice(v.text, {
        voiceId, modelId: m, stability: settings.stability, style: settings.style,
        similarity: settings.similarity, speakerBoost: settings.speakerBoost,
      });
      return { label: `${v.label} · ${m}`, variant: v.variant, model: m, text: v.text, audioUrl: r.url, error: r.ok ? undefined : r.error, debug: r.debug };
    }));
    clips.push(...part);
  }

  return { selectedVoiceId: voiceId, texts: { original, rewritten, normalized }, settings, clips };
}
