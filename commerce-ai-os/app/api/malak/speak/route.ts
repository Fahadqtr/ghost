// Malak voice — server-side ElevenLabs TTS. Holds ELEVENLABS_API_KEY (never
// sent to the browser) and synthesizes the given Arabic `speak` text with
// Malika's custom voice. Returns audio/mpeg. The client plays it; if this route
// is not configured (204) or errors (502), the client falls back to the
// browser's speechSynthesis voice so the voice never breaks.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODEL_ID = "eleven_multilingual_v2"; // strong Arabic support

// The 9 agent ids the brain can return (matches app/api/malak/route.ts).
const AGENT_IDS = [
  "malak", "noor", "bayan", "reem", "siraj", "razan", "rashid", "latifa", "salem",
];

// Per-agent voice. Each agent can have its OWN ElevenLabs voice via an
// `ELEVENLABS_VOICE_<AGENT>` env var (e.g. ELEVENLABS_VOICE_NOOR). When an
// agent-specific voice isn't set, we fall back to the shared ELEVENLABS_VOICE_ID
// (Malika) so nothing breaks and unconfigured agents still speak.
function resolveVoiceId(agent: unknown): string | undefined {
  const a = typeof agent === "string" ? agent.trim().toLowerCase() : "";
  if (a && AGENT_IDS.includes(a)) {
    const specific = process.env[`ELEVENLABS_VOICE_${a.toUpperCase()}`];
    if (specific && specific.trim()) return specific.trim();
  }
  return process.env.ELEVENLABS_VOICE_ID;
}

export async function POST(req: Request) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  // Not configured → tell the client to use its browser voice instead.
  if (!apiKey) return new Response(null, { status: 204 });

  let text = "";
  let agent: unknown;
  try {
    const body = await req.json();
    // Accept either { speak } or { text }.
    text = typeof body?.speak === "string" ? body.speak : typeof body?.text === "string" ? body.text : "";
    agent = body?.agent;
  } catch {
    return new Response("bad request", { status: 400 });
  }
  text = text.trim();
  if (!text) return new Response("no text", { status: 400 });

  const voiceId = resolveVoiceId(agent);
  // No voice configured at all → fall back to the browser voice client-side.
  if (!voiceId) return new Response(null, { status: 204 });

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
            // Lower stability + a touch more style => livelier, less robotic /
            // monotone delivery (still steady enough to avoid stuttering).
            stability: 0.55,
            similarity_boost: 0.85,
            style: 0.3,
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
