"use server";

import Anthropic from "@anthropic-ai/sdk";
import { requireUser } from "@/lib/auth/requireUser";
import { synthArabicVoice, elevenStatus, elevenVoiceId, elevenModelId, listGulfVoiceCandidates, type VoiceConnState } from "@/lib/social/voiceover";
import { buildGulfScriptPrompt, buildGulfDialectPrompt, cleanScriptLines, normalizeVoiceIds, type VoiceCandidate, type AuditionResult } from "@/lib/voice/voice-compute";

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

/** Rewrite a script into natural Qatari Gulf with TTS-safe pronunciation. */
export async function refineGulfScript(script: string): Promise<{ error: string } | { script: string }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const s = String(script || "").trim();
  if (!s) return { error: "اكتب سكربت أول." };
  const r = await claude(buildGulfDialectPrompt(s));
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
 * Voice Audition: synth the SAME line with up to 3 candidate voice ids so the
 * owner can compare and pick. Slightly more expressive settings (lower stability,
 * higher style) to avoid a flat read. Nothing is adopted automatically.
 */
export async function auditionVoices(input: { text: string; voiceIds: string[] }): Promise<{ error: string } | { results: AuditionResult[] }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const text = String(input.text || "").trim();
  if (!text) return { error: "لا يوجد نص للاختبار." };
  const ids = normalizeVoiceIds(input.voiceIds, 3);
  if (!ids.length) return { error: "أدخل Voice ID واحد على الأقل." };
  const results = await Promise.all(ids.map(async (voiceId): Promise<AuditionResult> => {
    const r = await synthArabicVoice(text, { voiceId, stability: 0.3, style: 0.45 });
    return r.ok && r.url ? { voiceId, audioUrl: r.url } : { voiceId, error: r.error || "فشل التوليد." };
  }));
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
