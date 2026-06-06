// Malak voice — server-side ElevenLabs TTS. Holds ELEVENLABS_API_KEY (never
// sent to the browser) and synthesizes the given Arabic `speak` text with
// Malika's custom voice. Returns audio/mpeg. The client plays it; if this route
// is not configured (204) or errors (502), the client falls back to the
// browser's speechSynthesis voice so the voice never breaks.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODEL_ID = "eleven_multilingual_v2"; // strong Arabic support

export async function POST(req: Request) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  // Not configured → tell the client to use its browser voice instead.
  if (!apiKey || !voiceId) return new Response(null, { status: 204 });

  let text = "";
  try {
    const body = await req.json();
    // Accept either { speak } or { text }.
    text = typeof body?.speak === "string" ? body.speak : typeof body?.text === "string" ? body.text : "";
  } catch {
    return new Response("bad request", { status: 400 });
  }
  text = text.trim();
  if (!text) return new Response("no text", { status: 400 });

  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: text.slice(0, 1500),
          model_id: process.env.ELEVENLABS_MODEL_ID || MODEL_ID,
          voice_settings: {
            // Higher stability => steadier delivery with fewer artifacts /
            // stutters. Lower `style` for the same reason (high style is the
            // main cause of wobble/stammering on multilingual_v2).
            stability: 0.62,
            similarity_boost: 0.85,
            style: 0.2,
            use_speaker_boost: true,
            // Just under default (1.0): natural, unhurried, but not so slow it
            // sounds dragged. ElevenLabs reads `speed` from voice_settings.
            speed: 0.95,
          },
        }),
      }
    );

    if (!r.ok) {
      const err = await r.text();
      console.error("[malak-speak] ElevenLabs", r.status, err.slice(0, 200));
      return new Response(null, { status: 502 });
    }

    const audio = await r.arrayBuffer();
    return new Response(audio, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (e: any) {
    console.error("[malak-speak] error", e?.message);
    return new Response(null, { status: 502 });
  }
}
