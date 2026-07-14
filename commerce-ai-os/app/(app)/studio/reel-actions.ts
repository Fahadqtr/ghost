"use server";

import Anthropic from "@anthropic-ai/sdk";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth/requireUser";
import { synthArabicVoice } from "@/lib/social/voiceover";
import { submitCompose, getCompose, composeConfigured, malikaLogoUrl, reelsMusicUrl } from "@/lib/social/compose";
import type { CaptionCue, LogoPosition } from "@/lib/social/compose-compute";
import {
  splitCaptions, timeCaptions, bilingualCaptions, buildBrandLine,
  DEFAULT_CTA, DEFAULT_LOGO_POSITION, type CaptionLanguage,
} from "@/lib/studio/caption-compute";

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
export async function composerStatus(): Promise<{ creatomate: boolean; logo: boolean; music: boolean }> {
  await requireUser();
  return { creatomate: composeConfigured(), logo: !!malikaLogoUrl(), music: !!reelsMusicUrl() };
}

export interface ReelSettings {
  videoUrl: string;
  script: string;
  language?: CaptionLanguage;
  cta?: string;
  logoPosition?: LogoPosition;
  showLogo?: boolean;
  productName?: string;
  handle?: string;
  useMusic?: boolean;
}

export interface ReelPrepared {
  audioUrl: string;
  durationSec?: number;
  captionLines: string[];
  cues: CaptionCue[];
  brandLine: string;
}

/**
 * Prepare the reel (for the preview step): synth the brand voice from the script
 * and build the timed caption plan. Voice engine defaults (voice id / model /
 * settings) are used as-is — no overrides here.
 */
export async function prepareFinalReel(input: ReelSettings): Promise<{ error: string } | ReelPrepared> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const videoUrl = String(input.videoUrl || "").trim();
  const script = String(input.script || "").trim();
  if (!/^https?:\/\//i.test(videoUrl)) return { error: "رابط فيديو FLORA غير صالح." };
  if (!script) return { error: "لا يوجد سكربت." };

  // 1) Brand voice (uses the adopted voice/model/settings — nothing changed).
  const voice = await synthArabicVoice(script);
  if (!voice.ok || !voice.url) return { error: voice.error || "فشل توليد الصوت." };

  // 2) Caption lines by language.
  const lang = input.language || "ar";
  const arLines = splitCaptions(script);
  let captionLines = arLines;
  if (lang !== "ar") {
    const en = await claudeText(`Translate each of these Arabic caption lines to short, natural marketing English. Return ONLY the English lines, one per line, same count and order:\n${arLines.join("\n")}`);
    const enLines = splitCaptions(String(en ?? ""));
    if (lang === "en" && enLines.length) captionLines = enLines;
    else if (lang === "ar_en" && enLines.length) captionLines = bilingualCaptions(arLines, enLines);
  }

  const cues = timeCaptions(captionLines, voice.durationSec ?? 0);
  const brandLine = buildBrandLine(input.productName, input.handle);
  return { audioUrl: voice.url, durationSec: voice.durationSec, captionLines, cues, brandLine };
}

/** Render the final reel via Creatomate from the prepared voice + caption plan. */
export async function composeFinalReel(input: ReelSettings & { audioUrl: string; durationSec?: number; cues: CaptionCue[]; brandLine: string }):
  Promise<{ error: string } | { renderId?: string; url?: string }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  if (!composeConfigured()) return { error: "Creatomate غير مهيأ (CREATOMATE_API_KEY في Vercel)." };

  const r = await submitCompose({
    videoUrl: input.videoUrl,
    audioUrl: input.audioUrl,
    durationSec: input.durationSec ?? null,
    captions: input.cues,
    ctaText: (input.cta ?? DEFAULT_CTA).trim() || DEFAULT_CTA,
    brandText: input.brandLine || null,
    logoUrl: input.showLogo === false ? null : (malikaLogoUrl() || null),
    logoPosition: input.logoPosition ?? DEFAULT_LOGO_POSITION,
    musicUrl: input.useMusic ? (reelsMusicUrl() || null) : null,
  });
  if (!r.ok) return { error: r.error || "فشل التركيب." };
  return { renderId: r.renderId, url: r.url };
}

/** Poll the final render. */
export async function pollFinalReel(renderId: string): Promise<{ error: string } | { status: string; url?: string }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const s = await getCompose(renderId);
  if (s.status === "failed") return { error: s.error || "فشل التركيب." };
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
