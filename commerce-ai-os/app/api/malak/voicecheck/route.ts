// TEMPORARY diagnostic — remove after the per-agent voice issue is resolved.
// Public (whitelisted in middleware). Two modes:
//   ?list=1        → the voices present in THIS ElevenLabs account (id/name/labels)
//   ?agent=rashid  → resolve that agent's voice + synth a short Arabic clip,
//                    report status / bytes / errorBody
//   (no param)     → synth test for every agent
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODEL_ID = "eleven_multilingual_v2";

const AGENT_IDS = [
  "malak", "noor", "bayan", "reem", "siraj", "razan", "rashid", "latifa", "salem",
];

const AGENT_VOICES: Record<string, string> = {
  noor: "UR972wNGq3zluze0LoIp",
  bayan: "L10lEremDiJfPicq5CPh",
  reem: "qi4PkV9c01kb869Vh7Su",
  razan: "a1KZUXKFVFDOb33I1uqr",
  latifa: "4wf10lgibMnboGJGCLrP",
  siraj: "mRdG9GYEjJmIzqbYTidv",
  rashid: "xvhpbk8otnNHtT3fjCpr",
  salem: "LCDnCIYLTaVg7otERNkl",
};

function voiceFor(agent: string): string | undefined {
  const a = agent.toLowerCase();
  const env = process.env[`ELEVENLABS_VOICE_${a.toUpperCase()}`];
  if (env && env.trim()) return env.trim();
  if (AGENT_VOICES[a]) return AGENT_VOICES[a];
  return process.env.ELEVENLABS_VOICE_ID;
}

async function synth(apiKey: string, voiceId: string) {
  const r = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text: "مرحبا، أنا من فريق ملاك.",
        model_id: MODEL_ID,
        voice_settings: { stability: 0.55, similarity_boost: 0.85, style: 0.3, use_speaker_boost: true },
      }),
    }
  );
  if (!r.ok) {
    const errorBody = (await r.text()).slice(0, 300);
    return { voiceId, status: r.status, ok: false, audioBytes: 0, errorBody };
  }
  const buf = await r.arrayBuffer();
  return { voiceId, status: 200, ok: true, audioBytes: buf.byteLength };
}

export async function GET(req: Request) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return Response.json({ error: "ELEVENLABS_API_KEY missing" }, { status: 200 });

  const url = new URL(req.url);

  // Mode 0: return the raw MP3 for an agent so it can be listened to directly,
  // bypassing the app entirely. ?audio=1&agent=malak
  if (url.searchParams.get("audio")) {
    const agent = (url.searchParams.get("agent") || "malak").toLowerCase();
    const v = voiceFor(agent);
    if (!v) return Response.json({ agent, error: "no voice resolved" });
    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(v)}`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({
          text: "السلام عليكم، أنا من فريق ملاك، كيف أقدر أساعدك اليوم؟",
          model_id: MODEL_ID,
          voice_settings: { stability: 0.55, similarity_boost: 0.85, style: 0.3, use_speaker_boost: true },
        }),
      }
    );
    if (!r.ok) return Response.json({ agent, voiceId: v, status: r.status, body: (await r.text()).slice(0, 300) });
    const audio = await r.arrayBuffer();
    return new Response(audio, { status: 200, headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
  }

  // Mode 1: list the account's voices.
  if (url.searchParams.get("list")) {
    const r = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": apiKey },
    });
    if (!r.ok) return Response.json({ error: `voices ${r.status}`, body: (await r.text()).slice(0, 300) });
    const data: any = await r.json();
    const voices = (data?.voices ?? []).map((v: any) => ({
      voice_id: v.voice_id,
      name: v.name,
      category: v.category,
      labels: v.labels,
    }));
    return Response.json({ count: voices.length, voices });
  }

  // Mode 2: single agent.
  const agent = url.searchParams.get("agent");
  if (agent) {
    const v = voiceFor(agent);
    if (!v) return Response.json({ agent, error: "no voice resolved" });
    return Response.json({ agent, ...(await synth(apiKey, v)) });
  }

  // Mode 3: every agent.
  const results: Record<string, any> = {};
  for (const a of AGENT_IDS) {
    const v = voiceFor(a);
    results[a] = v ? await synth(apiKey, v) : { error: "no voice" };
  }
  return Response.json({ results });
}
