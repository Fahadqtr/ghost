// Pure builders + text helpers for the Malika AI Studio Voice Engine.
// Gulf (Qatari white-Khaleeji) script writing + dialect/pronunciation refinement
// prompts, plus output cleanup. DB/API-free so they can be unit-tested.

export const GULF_VOICE_RULES = [
  "Write NATIVELY in natural WHITE GULF ARABIC understood in Qatar (Khaleeji, close to Qatari). Feminine, soft, warm, confident — a real beauty influencer, not an ad robot.",
  "Do NOT use Modern Standard Arabic (fus-ha) and do NOT mix dialects. NEVER Egyptian, Levantine, Moroccan, or heavy Iraqi. No dialect switching between sentences.",
  "Use Qatari feminine address where it sounds natural (e.g. بشرتج، روتينج، تقدرين، استخدميه).",
].join("\n");

export const GULF_PRONUNCIATION_RULES = [
  "Every word must be easy for a text-to-speech voice to pronounce correctly. Avoid words known to break Arabic TTS, English letters, product codes, and spelled-out numbers in the spoken lines.",
  "Add light tashkeel ONLY where it prevents a mispronunciation — do not fully vowel every word.",
  "Re-read each word; if any is hard to pronounce, replace it with a clearer Gulf synonym.",
].join("\n");

/** Prompt: write a fresh Gulf voiceover script (from a topic and/or product). */
export function buildGulfScriptPrompt(input: { topic?: string | null; productName?: string | null }): string {
  const topic = String(input.topic || "").trim();
  const name = String(input.productName || "").trim();
  return [
    `Write the spoken voiceover for a short Instagram beauty reel for the Qatari store Malika's Universe${name ? ` about «${name}»` : ""}.`,
    topic ? `Topic / angle: ${topic}` : ``,
    `DIALECT (most important):`,
    GULF_VOICE_RULES,
    `PRONUNCIATION SAFETY:`,
    GULF_PRONUNCIATION_RULES,
    `STRUCTURE: 3–4 short spoken lines, ~30 words total, with natural pauses. Hook → value → warm CTA.`,
    `Return ONLY the Arabic spoken lines, each on its own line — no numbering, no quotes, no English, no extra text.`,
  ].filter(Boolean).join("\n");
}

/** Prompt: rewrite an existing script into natural Qatari Gulf + TTS-safe pronunciation. */
export function buildGulfDialectPrompt(script: string): string {
  const s = String(script || "").trim();
  return [
    `Rewrite the following script into natural WHITE GULF ARABIC suitable for Qatar, and make every word easy for a text-to-speech voice to pronounce correctly.`,
    `DIALECT:`,
    GULF_VOICE_RULES,
    `PRONUNCIATION SAFETY:`,
    GULF_PRONUNCIATION_RULES,
    `Keep the same meaning and roughly the same length. Keep it spoken and natural — no stage directions, no emojis, no English.`,
    `Return ONLY the refined Arabic spoken text — each sentence on its own line, no numbering, no quotes, no commentary.`,
    ``,
    `Script:`,
    s,
  ].join("\n");
}

// The reference line used to audition/compare candidate voices — a natural,
// short, spoken Qatari sentence (real Khaleeji, not MSA with swapped words).
export const AUDITION_TEST_LINE =
  "ودّج تضيفين شي مميز لروتين العناية ببشرتج؟ شوفي هالمنتج... بسيط، عملي، ويستاهل يكون عندج.";

// What we want the brand voice to BE (the dialect must come from the voice,
// not from forcing Gulf words onto a non-Gulf speaker).
export const GULF_VOICE_BRIEF = [
  "Female",
  "Native Gulf Arabic",
  "Natural in Qatar",
  "Warm and conversational",
  "Premium beauty-ad style",
  "Not formal MSA",
  "Not Egyptian",
  "Not Levantine",
  "Not robotic",
];

// Shared shapes for the Voice Audition UI (pure so the client can import them).
export interface VoiceCandidate { voiceId: string; name: string; accent?: string; description?: string; previewUrl?: string; gender?: string }
export interface AuditionResult { voiceId: string; audioUrl?: string; error?: string }

/** Trim, drop blanks/duplicates, cap to `max` voice ids. */
export function normalizeVoiceIds(ids: (string | null | undefined)[], max = 3): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const v = String(raw ?? "").trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

/** True when an accent/description string reads as a Gulf/Khaleeji dialect. */
export function isGulfAccent(s: string | null | undefined): boolean {
  return /gulf|khaleeji|khaliji|khaleej|saudi|emirati|qatari|kuwaiti|bahraini|omani/i.test(String(s ?? ""));
}

/** Normalise a model's script output: strip numbering/bullets/quotes, drop blanks, cap lines. */
export function cleanScriptLines(text: string, maxLines = 6): string {
  return String(text ?? "")
    .split("\n")
    .map((l) => l.replace(/^[\s\d.)\-•*"'«»]+/, "").replace(/["'«»]+$/, "").trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .join("\n");
}
