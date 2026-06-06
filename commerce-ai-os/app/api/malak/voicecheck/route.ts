// TEMPORARY diagnostic — remove after diagnosing the ElevenLabs voice issue.
// Public (whitelisted in middleware) so it can be probed without a session.
// Reports ONLY booleans/lengths (never secret values) + the raw ElevenLabs
// status/error so we can see exactly why /api/malak/speak falls back.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const key = process.env.ELEVENLABS_API_KEY;
  const voice = process.env.ELEVENLABS_VOICE_ID;
  const model = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";

  const out: any = {
    env: {
      ELEVENLABS_API_KEY: key ? `present (len ${key.length})` : "MISSING",
      ELEVENLABS_VOICE_ID: voice ? `present (${voice})` : "MISSING",
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? "present" : "MISSING",
      model_used: model,
    },
  };

  if (key && voice) {
    try {
      const r = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`,
        {
          method: "POST",
          headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
          body: JSON.stringify({
            text: "تجربة",
            model_id: model,
            voice_settings: { stability: 0.5, similarity_boost: 0.8 },
          }),
        }
      );
      out.eleven = {
        status: r.status,
        ok: r.ok,
        contentType: r.headers.get("content-type"),
      };
      if (r.ok) out.eleven.audioBytes = (await r.arrayBuffer()).byteLength;
      else out.eleven.errorBody = (await r.text()).slice(0, 600);
    } catch (e: any) {
      out.eleven = { fetchError: e?.message };
    }
  } else {
    out.eleven = "skipped — env not configured";
  }

  return Response.json(out);
}
