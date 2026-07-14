import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Arabic voiceover via ElevenLabs — text → natural Gulf/Arabic speech (mp3),
// uploaded to storage so the composer (Creatomate) can pull a public URL.
// Env-gated: ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID (pick an Arabic voice).

const BASE = "https://api.elevenlabs.io/v1";
const BUCKET = "product-images"; // reuse the existing public bucket

function apiKey(): string { return String(process.env.ELEVENLABS_API_KEY ?? "").trim().replace(/^["']|["']$/g, ""); }
function voiceId(): string { return String(process.env.ELEVENLABS_VOICE_ID ?? "").trim().replace(/^["']|["']$/g, ""); }
function modelId(): string { return String(process.env.ELEVENLABS_MODEL_ID ?? "").trim().replace(/^["']|["']$/g, "") || "eleven_multilingual_v2"; }
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
 * Synthesize Arabic speech; returns a public mp3 URL and its exact duration.
 * Uses the /with-timestamps endpoint so we know how long the clip is — the
 * composer needs it to size the video (otherwise it runs long → black screen).
 */
export async function synthArabicVoice(text: string): Promise<{ ok: boolean; url?: string; durationSec?: number; error?: string }> {
  if (!voiceoverConfigured()) return { ok: false, error: "ElevenLabs غير مهيأ (ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID)." };
  const line = String(text ?? "").trim().slice(0, 800);
  if (!line) return { ok: false, error: "لا يوجد نص للصوت." };
  try {
    const r = await fetch(`${BASE}/text-to-speech/${encodeURIComponent(voiceId())}/with-timestamps`, {
      method: "POST",
      headers: { "xi-api-key": apiKey(), "Content-Type": "application/json", Accept: "application/json" },
      // Settings tuned for warmer, more natural delivery (less flat/robotic):
      // lower stability = more expressive, higher similarity + style + speaker boost.
      body: JSON.stringify({
        text: line,
        model_id: modelId(),
        voice_settings: { stability: 0.4, similarity_boost: 0.85, style: 0.35, use_speaker_boost: true },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("[voiceover] HTTP", r.status, t.slice(0, 400));
      return { ok: false, error: `ElevenLabs HTTP ${r.status} — ${t.slice(0, 200)}` };
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
    return { ok: true, url, durationSec: Number.isFinite(durationSec) ? durationSec : undefined };
  } catch (e: any) {
    console.error("[voiceover] threw", e?.message || e);
    return { ok: false, error: e?.message || "فشل توليد الصوت." };
  }
}
