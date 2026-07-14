import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Arabic voiceover via ElevenLabs — text → natural Gulf/Arabic speech (mp3),
// uploaded to storage so the composer (Creatomate) can pull a public URL.
// Env-gated: ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID (pick an Arabic voice).

const BASE = "https://api.elevenlabs.io/v1";
const BUCKET = "product-images"; // reuse the existing public bucket

function apiKey(): string { return String(process.env.ELEVENLABS_API_KEY ?? "").trim().replace(/^["']|["']$/g, ""); }
function voiceId(): string { return String(process.env.ELEVENLABS_VOICE_ID ?? "").trim().replace(/^["']|["']$/g, ""); }
export function voiceoverConfigured(): boolean { return !!apiKey() && !!voiceId(); }

/** Synthesize Arabic speech; returns a public mp3 URL. */
export async function synthArabicVoice(text: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  if (!voiceoverConfigured()) return { ok: false, error: "ElevenLabs غير مهيأ (ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID)." };
  const line = String(text ?? "").trim().slice(0, 800);
  if (!line) return { ok: false, error: "لا يوجد نص للصوت." };
  try {
    const r = await fetch(`${BASE}/text-to-speech/${encodeURIComponent(voiceId())}`, {
      method: "POST",
      headers: { "xi-api-key": apiKey(), "Content-Type": "application/json", Accept: "audio/mpeg" },
      // multilingual v2 covers Arabic; settings tuned for steady, natural delivery.
      body: JSON.stringify({ text: line, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("[voiceover] HTTP", r.status, t.slice(0, 400));
      return { ok: false, error: `ElevenLabs HTTP ${r.status} — ${t.slice(0, 200)}` };
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return { ok: false, error: "الصوت رجع فارغًا." };
    let admin: any;
    try { admin = createAdminClient(); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "الخادم غير مهيأ." }; }
    const path = `reels-audio/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`;
    const { error: up } = await admin.storage.from(BUCKET).upload(path, buf, { contentType: "audio/mpeg", upsert: true });
    if (up) { console.error("[voiceover] upload", up.message); return { ok: false, error: `رفع الصوت فشل: ${up.message}` }; }
    const url = admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    return { ok: true, url };
  } catch (e: any) {
    console.error("[voiceover] threw", e?.message || e);
    return { ok: false, error: e?.message || "فشل توليد الصوت." };
  }
}
