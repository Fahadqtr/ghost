"use server";

import Anthropic from "@anthropic-ai/sdk";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth/requireUser";
import { synthArabicVoice } from "@/lib/social/voiceover";
import { submitCompose, getCompose, composeConfigured, malikaLogoUrl, reelsMusicUrl } from "@/lib/social/compose";
import type { CaptionCue, LogoPosition, ReelQA } from "@/lib/social/compose-compute";
import { resolveReelDuration, reelQA, REEL_WIDTH, REEL_HEIGHT } from "@/lib/social/compose-compute";
import {
  splitCaptions, timeCaptions, bilingualCaptions, buildBrandLine, alignCaptions, ctaWindow,
  DEFAULT_CTA, DEFAULT_LOGO_POSITION, type CaptionLanguage,
} from "@/lib/studio/caption-compute";
import { submitProductVideo, pollProductVideo } from "@/lib/video/provider-router";
import { floraConfigured, checkFloraTechnique, type FloraTechniqueCheck } from "@/lib/video/flora";
import { planReelShots, shotCountForDuration, MIN_SHOTS, MAX_SHOTS, type ShotKey } from "@/lib/video/shot-plan";

// Malika AI Studio → Final Reel Composer (phase 4). Takes a FLORA product video
// + the approved brand voice, then layers timed Arabic captions, the Malika logo,
// a CTA, and (optionally) ducked music into an Instagram-ready 1080×1920 mp4 via
// the existing Creatomate composer. FLORA + the voice engine are used AS-IS.

async function claudeText(prompt: string, maxTokens = 500): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: process.env.STAFF_MALAK_MODEL || "claude-sonnet-4-6",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });
    return resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim() || null;
  } catch { return null; }
}

/** Which engines the composer needs. */
export async function composerStatus(): Promise<{ creatomate: boolean; logo: boolean; music: boolean; flora: boolean }> {
  await requireUser();
  return { creatomate: composeConfigured(), logo: !!malikaLogoUrl(), music: !!reelsMusicUrl(), flora: floraConfigured() };
}

export interface ShotJob { key: ShotKey; labelAr: string; labelEn: string; requestId?: string; error?: string }

/**
 * DEFAULT reel behaviour: generate several DIFFERENT FLORA shots of the SAME
 * product (hero → detail → [lifestyle] → CTA) from one product image, so the
 * final reel looks like a real, varied ad instead of one looped clip. Each shot
 * is a separate FLORA run; the client polls them, then they're sequenced across
 * the voice length. Looping a single clip is only a fallback (when generation
 * isn't available or only one shot succeeds).
 */
export async function generateReelShots(imageUrl: string, count?: number): Promise<{ error: string } | { shots: ShotJob[] }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const img = String(imageUrl || "").trim();
  if (!/^https?:\/\//i.test(img)) return { error: "ارفع صورة المنتج أو ضع رابطًا صالحًا أولاً." };
  if (!floraConfigured()) return { error: "FLORA غير مهيأ (FLORA_API_KEY / FLORA_TECHNIQUE_SLUG) — أو الصق روابط اللقطات يدويًا." };
  const n = Math.max(MIN_SHOTS, Math.min(MAX_SHOTS, Math.round(count || 0) || MIN_SHOTS));
  const specs = planReelShots(n);
  // Fire all shot generations; each is an independent FLORA run.
  const shots = await Promise.all(specs.map(async (s): Promise<ShotJob> => {
    const r = await submitProductVideo({ imageUrl: img, prompt: s.prompt, kind: "luxury_product_ad" });
    return r.ok && r.requestId
      ? { key: s.key, labelAr: s.labelAr, labelEn: s.labelEn, requestId: r.requestId }
      : { key: s.key, labelAr: s.labelAr, labelEn: s.labelEn, error: r.error || "فشل بدء اللقطة" };
  }));
  if (shots.every((s) => !s.requestId)) return { error: shots.find((s) => s.error)?.error || "فشل توليد اللقطات." };
  return { shots };
}

/** Poll a single generated shot; returns the FLORA video URL once ready. */
export async function pollReelShot(requestId: string): Promise<{ error: string } | { status: string; videoUrl?: string }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const s = await pollProductVideo(requestId);
  if (s.status === "failed") return { error: s.error || "فشلت اللقطة." };
  return { status: s.status, videoUrl: s.videoUrl };
}

/** Suggested shot count for a voiceover length (3 default, 4 for longer voice). */
export async function suggestedShotCount(voiceSec?: number): Promise<number> {
  await requireUser();
  return shotCountForDuration(voiceSec);
}

/**
 * Read-only check: does the published FLORA technique accept a motion-prompt
 * input (visual_prompt)? Use to confirm the wiring BEFORE enabling
 * FLORA_SEND_PROMPT — it starts no run, so it never costs a generation.
 */
export async function verifyFloraTechnique(): Promise<FloraTechniqueCheck> {
  const unauth = await requireUser();
  if (unauth) return { ok: false, configured: false, slug: "", sendPromptEnabled: false, promptInputId: "visual_prompt", detail: "unauthorized" };
  return checkFloraTechnique();
}

export interface ReelSettings {
  videoUrl: string;
  videoUrls?: string[];      // multiple FLORA shots (sequenced across the timeline)
  script: string;
  language?: CaptionLanguage;
  cta?: string;
  logoPosition?: LogoPosition;
  showLogo?: boolean;
  productName?: string;
  productDescription?: string;
  handle?: string;
  useMusic?: boolean;
}

export interface ReelPrepared {
  audioUrl: string;
  durationSec?: number;      // measured voiceover length
  finalDurationSec: number;  // the reel length (voice + short tail, bounded)
  captionLines: string[];
  cues: CaptionCue[];
  syncedToVoice: boolean;    // captions timed from real ElevenLabs timestamps?
  brandLine: string;
}

/**
 * Product-aware script: writes a short Gulf-Arabic reel script grounded in the
 * ACTUAL product name + description — never a generic template. Used before the
 * voice is synthesized so the audio/captions match the product.
 */
export async function draftReelScript(productName: string, productDescription?: string): Promise<{ error: string } | { script: string }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const name = String(productName || "").trim();
  const desc = String(productDescription || "").trim();
  if (!name && !desc) return { error: "اكتب اسم المنتج أو وصفه أولاً." };
  const prompt = `اكتب سكربت قصير لريل إنستغرام باللهجة الخليجية (قطر) لمنتج عناية بالبشرة من متجر مالكا.
اعتمد حرفياً على بيانات المنتج التالية ولا تستخدم كلامًا عامًا لا يخصه:
- الاسم: ${name || "—"}
- الوصف: ${desc || "—"}
الشروط: أنثوي ودافئ وراقٍ، جملتان إلى ثلاث جمل قصيرة فقط (يُقرأ في 8–12 ثانية)، بدون تشكيل، بدون إيموجي، اذكر فائدة المنتج الفعلية، وأنهِ بدعوة لطيفة للشراء. أعطني النص فقط.`;
  const out = await claudeText(prompt, 400);
  const script = String(out ?? "").trim();
  if (!script) return { error: "تعذّر توليد السكربت (تأكد من ANTHROPIC_API_KEY)." };
  return { script };
}

/**
 * Prepare the reel (for the preview step): synth the brand voice from the script
 * and build the timed caption plan. Voice engine defaults (voice id / model /
 * settings) are used as-is — no overrides here.
 */
export async function prepareFinalReel(input: ReelSettings): Promise<{ error: string } | ReelPrepared> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const shots = (input.videoUrls?.length ? input.videoUrls : [input.videoUrl])
    .map((u) => String(u || "").trim()).filter((u) => /^https?:\/\//i.test(u));
  if (!shots.length) return { error: "رابط فيديو FLORA غير صالح." };

  // Product-aware script: if none was pasted but we have product data, write one
  // grounded in the actual product — never a generic template.
  let script = String(input.script || "").trim();
  if (!script && (input.productName || input.productDescription)) {
    const drafted = await draftReelScript(input.productName || "", input.productDescription);
    if (!("error" in drafted)) script = drafted.script;
  }
  if (!script) return { error: "لا يوجد سكربت (اكتب اسم المنتج ووصفه ثم «اكتب السكربت»)." };

  // 1) Brand voice (uses the adopted voice/model/settings — nothing changed).
  const voice = await synthArabicVoice(script);
  if (!voice.ok || !voice.url) return { error: voice.error || "فشل توليد الصوت." };

  // 2) Arabic caption lines drive the timing (they match the audio stream).
  const lang = input.language || "ar";
  const arLines = splitCaptions(script);
  const finalDurationSec = resolveReelDuration(voice.durationSec);

  // Precise sync from the real ElevenLabs character timestamps; fall back to
  // duration-weighted timing if the alignment isn't usable.
  const aligned = voice.alignment ? alignCaptions(arLines, voice.alignment) : null;
  const syncedToVoice = !!aligned;
  const arCues = aligned ?? timeCaptions(arLines, voice.durationSec ?? finalDurationSec);

  // 3) Display language: keep the Arabic cue TIMES, swap the display text.
  let captionLines = arLines;
  let cues = arCues;
  if (lang !== "ar") {
    const en = await claudeText(`Translate each of these Arabic caption lines to short, natural marketing English. Return ONLY the English lines, one per line, same count and order:\n${arLines.join("\n")}`);
    const enLines = splitCaptions(String(en ?? ""));
    if (lang === "en" && enLines.length) captionLines = enLines;
    else if (lang === "ar_en" && enLines.length) captionLines = bilingualCaptions(arLines, enLines);
    // Reuse the synced Arabic times for the displayed lines (1:1 by line).
    cues = captionLines.map((text, i) => ({ text, time: arCues[i]?.time ?? 0, duration: arCues[i]?.duration ?? 1 }));
  }

  const brandLine = buildBrandLine(input.productName, input.handle);
  return { audioUrl: voice.url, durationSec: voice.durationSec, finalDurationSec, captionLines, cues, syncedToVoice, brandLine };
}

/** Render the final reel via Creatomate from the prepared voice + caption plan. */
export async function composeFinalReel(input: ReelSettings & { audioUrl: string; durationSec?: number; cues: CaptionCue[]; brandLine: string }):
  Promise<{ error: string; qa?: ReelQA } | { renderId?: string; url?: string; qa?: ReelQA }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  if (!composeConfigured()) return { error: "Creatomate غير مهيأ (CREATOMATE_API_KEY في Vercel)." };

  const shots = (input.videoUrls?.length ? input.videoUrls : [input.videoUrl])
    .map((u) => String(u || "").trim()).filter((u) => /^https?:\/\//i.test(u));
  const finalDur = resolveReelDuration(input.durationSec);

  const r = await submitCompose({
    videoUrl: shots[0] || input.videoUrl,
    videoUrls: shots,
    audioUrl: input.audioUrl,
    durationSec: input.durationSec ?? null,
    captions: input.cues,
    ctaText: (input.cta ?? DEFAULT_CTA).trim() || DEFAULT_CTA,
    ctaWindow: ctaWindow(finalDur),
    brandText: input.brandLine || null,
    logoUrl: input.showLogo === false ? null : (malikaLogoUrl() || null),
    logoPosition: input.logoPosition ?? DEFAULT_LOGO_POSITION,
    musicUrl: input.useMusic ? (reelsMusicUrl() || null) : null,
  });
  if (!r.ok) return { error: r.error || "فشل التركيب." };
  // If Creatomate returned a final URL synchronously, QA it now.
  if (r.url) {
    const qa = reelQA({ width: r.width, height: r.height, durationSec: r.durationSec }, input.durationSec);
    if (!qa.pass && r.width && r.height && (r.width < REEL_WIDTH || r.height < REEL_HEIGHT)) {
      return { error: `الناتج ${r.width}×${r.height} أقل من ${REEL_WIDTH}×${REEL_HEIGHT} — فشل التصدير.`, qa };
    }
    return { url: r.url, qa };
  }
  return { renderId: r.renderId };
}

/** Poll the final render + run Final QA (resolution / duration) on completion. */
export async function pollFinalReel(renderId: string, voiceSec?: number): Promise<{ error: string } | { status: string; url?: string; qa?: ReelQA }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const s = await getCompose(renderId);
  if (s.status === "failed") return { error: s.error || "فشل التركيب." };
  if (s.status === "completed" && s.url) {
    const qa = reelQA({ width: s.width, height: s.height, durationSec: s.durationSec }, voiceSec ?? null);
    // A low-res proxy (smaller than 1080×1920) is a failure, not a Final.
    if (s.width && s.height && (s.width < REEL_WIDTH || s.height < REEL_HEIGHT)) {
      return { error: `الناتج ${s.width}×${s.height} أقل من ${REEL_WIDTH}×${REEL_HEIGHT} — فشل التصدير.` };
    }
    return { status: s.status, url: s.url, qa };
  }
  return { status: s.status, url: s.url };
}

/** Save the finished reel + its full recipe to the studio library (best-effort). */
export async function saveStudioReel(meta: {
  videoUrl: string; productSku?: string; productName?: string; script?: string; language?: string;
  voiceSettings?: unknown; floraGeneration?: unknown; captionSettings?: unknown; logoSettings?: unknown; cta?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const unauth = await requireUser();
  if (unauth) return { ok: false, error: "unauthorized" };
  try {
    const db = createAdminClient();
    const { error } = await db.from("studio_reels").insert({
      status: "ready",
      video_url: meta.videoUrl,
      product_sku: meta.productSku ?? null,
      product_name: meta.productName ?? null,
      script: meta.script ?? null,
      language: meta.language ?? null,
      voice_settings: meta.voiceSettings ?? null,
      flora_generation: meta.floraGeneration ?? null,
      caption_settings: meta.captionSettings ?? null,
      logo_settings: meta.logoSettings ?? null,
      cta: meta.cta ?? null,
    });
    if (error) {
      // Table not migrated yet → don't fail the reel; the mp4 URL is already returned.
      if (/studio_reels.*(does not exist|schema cache)|relation .*studio_reels/i.test(error.message)) {
        console.error("[studio_reels] table missing — skipped save");
        return { ok: false, error: "المكتبة غير مفعّلة بعد (جدول studio_reels)." };
      }
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || "فشل الحفظ." };
  }
}
