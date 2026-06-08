// TEMPORARY voice sampler — remove after the agent voices are verified.
// GET ?agent=rashid → returns an MP3 of that agent introducing itself, so the
// user can listen and confirm accent (Gulf?) and gender per agent.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODEL_ID = "eleven_multilingual_v2";

// Must mirror app/api/malak/speak/route.ts.
const AGENT_VOICES: Record<string, string> = {
  noor: "UR972wNGq3zluze0LoIp",
  bayan: "L10lEremDiJfPicq5CPh",
  reem: "qi4PkV9c01kb869Vh7Su",
  razan: "a1KZUXKFVFDOb33I1uqr",
  latifa: "4wf10lgibMnboGJGCLrP",
  siraj: "mRdG9GYEjJmIzqbYTidv",
  rashid: "DANw8bnAVbjDEHwZIoYa",
  salem: "LCDnCIYLTaVg7otERNkl",
};

const ROLE: Record<string, string> = {
  malak: "الإدارة العامة",
  noor: "الكتالوج",
  bayan: "المحتوى",
  reem: "الصور",
  siraj: "التواصل والنشر",
  razan: "التسعير",
  rashid: "التقارير",
  latifa: "العملاء",
  salem: "العمليات",
};
const NAME: Record<string, string> = {
  malak: "ملاك", noor: "نور", bayan: "بيان", reem: "ريم", siraj: "سراج",
  razan: "رزان", rashid: "راشد", latifa: "لطيفة", salem: "سالم",
};

function voiceFor(agent: string): string | undefined {
  const env = process.env[`ELEVENLABS_VOICE_${agent.toUpperCase()}`];
  if (env && env.trim()) return env.trim();
  return AGENT_VOICES[agent] || process.env.ELEVENLABS_VOICE_ID;
}

export async function GET(req: Request) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return Response.json({ error: "ELEVENLABS_API_KEY missing" });
  const url = new URL(req.url);

  // Browse mode: list Arabic shared-library voices (needs voices_read scope).
  if (url.searchParams.get("browse")) {
    const gender = url.searchParams.get("gender") || "";
    const q = new URLSearchParams({ page_size: "60", language: "ar" });
    if (gender) q.set("gender", gender);
    const r = await fetch(`https://api.elevenlabs.io/v1/shared-voices?${q.toString()}`, {
      headers: { "xi-api-key": apiKey },
    });
    if (!r.ok) return Response.json({ error: `shared ${r.status}`, body: (await r.text()).slice(0, 400) });
    const data: any = await r.json();
    const voices = (data?.voices ?? []).map((v: any) => ({
      voice_id: v.voice_id,
      name: v.name,
      gender: v.gender,
      accent: v.accent,
      age: v.age,
      descriptive: v.descriptive,
      use_case: v.use_case,
    }));
    return Response.json({ count: voices.length, voices });
  }

  const agent = (url.searchParams.get("agent") || "rashid").toLowerCase();
  const voiceId = voiceFor(agent);
  if (!voiceId) return Response.json({ agent, error: "no voice" });
  const text = `مرحبا، معاك ${NAME[agent] ?? agent} من قسم ${ROLE[agent] ?? ""}. حياك الله يا فهد، كيف أقدر أساعدك اليوم؟`;
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: MODEL_ID,
      voice_settings: { stability: 0.55, similarity_boost: 0.9, style: 0.15, use_speaker_boost: true, speed: 0.95 },
    }),
  });
  if (!r.ok) return Response.json({ agent, voiceId, status: r.status, body: (await r.text()).slice(0, 300) });
  const audio = await r.arrayBuffer();
  return new Response(audio, { status: 200, headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
}
