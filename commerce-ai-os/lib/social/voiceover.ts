import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isGulfAccent, type VoiceCandidate } from "@/lib/voice/voice-compute";

// Arabic voiceover via ElevenLabs — text → natural Gulf/Arabic speech (mp3),
// uploaded to storage so the composer (Creatomate) can pull a public URL.
// Env-gated: ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID (pick an Arabic voice).

const BASE = "https://api.elevenlabs.io/v1";
const BUCKET = "product-images"; // reuse the existing public bucket

function apiKey(): string { return String(process.env.ELEVENLABS_API_KEY ?? "").trim().replace(/^["']|["']$/g, ""); }
function voiceId(): string { return String(process.env.ELEVENLABS_VOICE_ID ?? "").trim().replace(/^["']|["']$/g, ""); }
// eleven_v3 renders the Gulf accent noticeably better than multilingual_v2
// (confirmed via the studio Voice Debug). Override with ELEVENLABS_MODEL_ID.
function modelId(): string { return String(process.env.ELEVENLABS_MODEL_ID ?? "").trim().replace(/^["']|["']$/g, "") || "eleven_v3"; }
export function voiceoverConfigured(): boolean { return !!apiKey() && !!voiceId(); }
export function elevenVoiceId(): string { return voiceId(); }
export function elevenModelId(): string { return modelId(); }

export type VoiceConnState = "connected" | "not_connected" | "error";

/**
 * Live connection status for the studio Voice Engine. Validates the key AND the
 * voice id in one call (GET /voices/{id}) so the studio can show Connected /
 * Not Connected / Error precisely.
 */
export async function elevenStatus(): Promise<{ state: VoiceConnState; detail?: string; voiceId: string; model: string }> {
  const vid = voiceId(); const model = modelId();
  if (!apiKey()) return { state: "not_connected", detail: "لا يوجد ELEVENLABS_API_KEY.", voiceId: vid, model };
  if (!vid) return { state: "not_connected", detail: "لا يوجد ELEVENLABS_VOICE_ID.", voiceId: vid, model };
  try {
    const r = await fetch(`${BASE}/voices/${encodeURIComponent(vid)}`, {
      headers: { "xi-api-key": apiKey() }, cache: "no-store", signal: AbortSignal.timeout(12_000),
    });
    if (r.ok) return { state: "connected", voiceId: vid, model };
    if (r.status === 401) return { state: "error", detail: "مفتاح ElevenLabs غير صالح.", voiceId: vid, model };
    if (r.status === 404) return { state: "error", detail: "Voice ID غير موجود في حسابك.", voiceId: vid, model };
    const t = await r.text();
    return { state: "error", detail: `ElevenLabs HTTP ${r.status} — ${t.slice(0, 120)}`, voiceId: vid, model };
  } catch (e: any) {
    return { state: "error", detail: e?.message || "تعذّر الاتصال بـ ElevenLabs.", voiceId: vid, model };
  }
}

/**
 * Fetch candidate female Arabic voices from the ElevenLabs voice library so the
 * owner can audition and pick a native Gulf speaker. Gulf/Khaleeji accents are
 * surfaced first. Read-only discovery — nothing is adopted automatically.
 */
export async function listGulfVoiceCandidates(): Promise<{ ok: boolean; voices: VoiceCandidate[]; error?: string }> {
  if (!apiKey()) return { ok: false, voices: [], error: "لا يوجد ELEVENLABS_API_KEY." };
  try {
    const params = new URLSearchParams({ gender: "female", language: "ar", page_size: "40" });
    const r = await fetch(`${BASE}/shared-voices?${params.toString()}`, {
      headers: { "xi-api-key": apiKey() }, cache: "no-store", signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) { const t = await r.text(); return { ok: false, voices: [], error: `ElevenLabs HTTP ${r.status} — ${t.slice(0, 140)}` }; }
    const j: any = await r.json();
    const arr: any[] = Array.isArray(j?.voices) ? j.voices : [];
    const voices: VoiceCandidate[] = arr
      .map((v: any): VoiceCandidate => ({
        voiceId: v?.voice_id, name: v?.name, accent: v?.accent, description: v?.description,
        previewUrl: v?.preview_url, gender: v?.gender,
      }))
      .filter((v) => !!v.voiceId);
    // Gulf/Khaleeji accents first, then the rest.
    voices.sort((a, b) => Number(isGulfAccent(b.accent) || isGulfAccent(b.description)) - Number(isGulfAccent(a.accent) || isGulfAccent(a.description)));
    return { ok: true, voices: voices.slice(0, 12) };
  } catch (e: any) {
    return { ok: false, voices: [], error: e?.message || "تعذّر جلب الأصوات." };
  }
}

/**
 * Synthesize Arabic speech; returns a public mp3 URL and its exact duration.
 * Uses the /with-timestamps endpoint so we know how long the clip is — the
 * composer needs it to size the video (otherwise it runs long → black screen).
 */
function envNum(v: string | undefined, def: number): number { const n = Number(String(v ?? "").trim()); return Number.isFinite(n) ? n : def; }

export interface VoiceDebug { voiceId: string; modelId: string; stability: number; similarityBoost: number; style: number; useSpeakerBoost: boolean; languageCode: string | null; textLen: number }

export async function synthArabicVoice(
  text: string,
  opts?: { voiceId?: string; modelId?: string; stability?: number; style?: number; similarity?: number; speakerBoost?: boolean },
): Promise<{ ok: boolean; url?: string; durationSec?: number; error?: string; debug?: VoiceDebug }> {
  // Voice id can be overridden (for the studio audition/compare); default = env.
  const vid = String(opts?.voiceId ?? "").trim() || voiceId();
  if (!apiKey() || !vid) return { ok: false, error: "ElevenLabs غير مهيأ (ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID)." };
  const line = String(text ?? "").trim().slice(0, 800);
  if (!line) return { ok: false, error: "لا يوجد نص للصوت." };
  const model = String(opts?.modelId ?? "").trim() || modelId();
  const stability = opts?.stability ?? envNum(process.env.ELEVENLABS_STABILITY, 0.4);
  const style = opts?.style ?? envNum(process.env.ELEVENLABS_STYLE, 0.35);
  const similarity = opts?.similarity ?? envNum(process.env.ELEVENLABS_SIMILARITY, 0.85);
  const speakerBoost = opts?.speakerBoost ?? true;
  // We deliberately do NOT send language_code — it isn't supported across all
  // models and can shift the accent. Log every request (never the API key).
  const debug: VoiceDebug = { voiceId: vid, modelId: model, stability, similarityBoost: similarity, style, useSpeakerBoost: speakerBoost, languageCode: null, textLen: line.length };
  console.log("[voiceover] tts request", JSON.stringify({ ...debug, textPreview: line.slice(0, 60) }));
  try {
    const r = await fetch(`${BASE}/text-to-speech/${encodeURIComponent(vid)}/with-timestamps`, {
      method: "POST",
      headers: { "xi-api-key": apiKey(), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        text: line,
        model_id: model,
        voice_settings: { stability, similarity_boost: similarity, style, use_speaker_boost: speakerBoost },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("[voiceover] HTTP", r.status, t.slice(0, 400));
      return { ok: false, error: `ElevenLabs HTTP ${r.status} — ${t.slice(0, 200)}`, debug };
    }
    const j: any = await r.json();
    const b64 = j?.audio_base64;
    if (!b64 || typeof b64 !== "string") return { ok: false, error: "الصوت رجع فارغًا." };
    const buf = Buffer.from(b64, "base64");
    if (!buf.length) return { ok: false, error: "الصوت رجع فارغًا." };
    // Duration = the last character-end time from the alignment (seconds).
    const ends: number[] = j?.alignment?.character_end_times_seconds
      ?? j?.normalized_alignment?.character_end_times_seconds ?? [];
    const durationSec = Array.isArray(ends) && ends.length ? Number(ends[ends.length - 1]) : undefined;
    let admin: any;
    try { admin = createAdminClient(); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "الخادم غير مهيأ." }; }
    const path = `reels-audio/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`;
    const { error: up } = await admin.storage.from(BUCKET).upload(path, buf, { contentType: "audio/mpeg", upsert: true });
    if (up) { console.error("[voiceover] upload", up.message); return { ok: false, error: `رفع الصوت فشل: ${up.message}` }; }
    const url = admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    return { ok: true, url, durationSec: Number.isFinite(durationSec) ? durationSec : undefined, debug };
  } catch (e: any) {
    console.error("[voiceover] threw", e?.message || e);
    return { ok: false, error: e?.message || "فشل توليد الصوت." };
  }
}
