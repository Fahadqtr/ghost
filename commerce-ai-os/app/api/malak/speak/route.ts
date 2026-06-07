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

// Per-agent voice. Each of the 8 specialists has its own ElevenLabs voice
// (Arabic, chosen to fit the agent's role); Malak keeps the shared Malika
// voice (ELEVENLABS_VOICE_ID). Any agent can be overridden at runtime with an
// `ELEVENLABS_VOICE_<AGENT>` env var (e.g. ELEVENLABS_VOICE_NOOR). A voice_id is
// not a secret — it only works together with this account's API key.
const AGENT_VOICES: Record<string, string> = {
  noor: "UR972wNGq3zluze0LoIp", // الكتالوج — أنثى واضحة محايدة
  bayan: "L10lEremDiJfPicq5CPh", // المحتوى — أنثى معبّرة حيوية
  reem: "qi4PkV9c01kb869Vh7Su", // الصور — أنثى ناعمة هادئة
  razan: "a1KZUXKFVFDOb33I1uqr", // التسعير — أنثى حازمة عملية
  latifa: "4wf10lgibMnboGJGCLrP", // العملاء — أنثى ودودة مرحّبة
  siraj: "mRdG9GYEjJmIzqbYTidv", // النشر — ذكر شاب نشيط
  rashid: "xvhpbk8otnNHtT3fjCpr", // التقارير — ذكر رصين عميق
  salem: "LCDnCIYLTaVg7otERNkl", // العمليات — ذكر ثابت ناضج
};

// Resolution order per agent: ELEVENLABS_VOICE_<AGENT> env override →
// the built-in AGENT_VOICES entry → the shared ELEVENLABS_VOICE_ID (Malika).
// The shared id is always the final fallback so nothing breaks if a voice is
// unset/unavailable.
function resolveVoiceId(agent: unknown): string | undefined {
  const a = typeof agent === "string" ? agent.trim().toLowerCase() : "";
  if (a && AGENT_IDS.includes(a)) {
    const specific = process.env[`ELEVENLABS_VOICE_${a.toUpperCase()}`];
    if (specific && specific.trim()) return specific.trim();
    if (AGENT_VOICES[a]) return AGENT_VOICES[a];
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

  // The shared Malika voice is our known-good Arabic fallback: if an agent's
  // own voice fails (e.g. a library voice that isn't added to this account),
  // we'd rather speak Arabic with Malika than drop to the browser's voice,
  // which on a PC with no Arabic system voice reads Arabic in English.
  const fallbackId = process.env.ELEVENLABS_VOICE_ID;

  const synthesize = (id: string) =>
    fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(id)}`, {
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
          // Slower, more natural delivery. style 0.35 keeps it expressive.
          stability: 0.5,
          similarity_boost: 0.85,
          style: 0.35,
          use_speaker_boost: true,
          // Below default (1.0) → slower, calmer. ElevenLabs reads `speed` from
          // voice_settings (ignored if the endpoint/model doesn't support it).
          speed: 0.9,
        },
      }),
    });

  try {
    let r = await synthesize(voiceId);

    // Agent voice failed → retry once with the Malika fallback (Arabic) before
    // giving up and letting the client use the browser voice.
    if (!r.ok && fallbackId && fallbackId !== voiceId) {
      const err = await r.text();
      console.error("[malak-speak] agent voice failed", r.status, err.slice(0, 200), "→ retrying with fallback");
      r = await synthesize(fallbackId);
    }

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
