// Weekly Reels engine — pure, DB-free (unit-tested).
//
// Produces a 14-Reels/week plan across 5 UGC formats (3/3/3/3/2), each item
// carrying an ENGLISH Higgsfield prompt (Arabic breaks generation), a Gulf
// Arabic caption brief, a CTA type, and a schedule slot at 13:00 & 20:00 Doha.
// The operator generates the video, the caption is written per-Reel by the
// existing Claude flow, and each row is queued into social_posts (format +
// cta_type columns) for the existing approval + publish cron.

export type ReelFormatKey = "entertainment" | "street_interview" | "unboxing" | "review" | "asmr";
export type CtaType = "growth" | "conversion";

export interface ReelFormat {
  key: ReelFormatKey;
  labelAr: string;
  perWeek: number;
  apiAudioSafe: boolean; // true → publishable via Graph API without trending audio
  defaultCta: CtaType;
  promptEn: (product: string) => string; // English Higgsfield prompt
  captionGuideAr: string; // brief for the Arabic caption writer
}

// Sum of perWeek MUST equal REELS_PER_WEEK.
export const REELS_PER_WEEK = 14;

export const REEL_FORMATS: ReelFormat[] = [
  {
    key: "entertainment", labelAr: "ترفيهي / تحدّي", perWeek: 3, apiAudioSafe: false, defaultCta: "growth",
    promptEn: (p) => `Vertical 9:16, 8 seconds. A stylish young Gulf woman in a modern Doha setting does a fast, fun beauty challenge featuring ${p}. Punchy visual hook in the first 1.5 seconds, quick cuts, trendy energetic vibe, bright soft lighting, no on-screen text.`,
    captionGuideAr: "هوك تحدّي مرح بأول سطر · طاقة عالية · دعوة للمشاركة (جرّبيها ووريينا).",
  },
  {
    key: "street_interview", labelAr: "مقابلة شارع", perWeek: 3, apiAudioSafe: false, defaultCta: "growth",
    promptEn: (p) => `Vertical 9:16, 12 seconds, candid street-interview style in an upscale Doha mall. A friendly host asks a shopper to rate ${p} out of 10; genuine reaction, handheld camera, natural lighting, no on-screen text.`,
    captionGuideAr: "ابدئي بـ«كم تعطينه من ١٠؟» · فضول · دعوة للتعليق برأيهم.",
  },
  {
    key: "unboxing", labelAr: "فتح علبة", perWeek: 3, apiAudioSafe: false, defaultCta: "growth",
    promptEn: (p) => `Vertical 9:16, 10 seconds. Close-up unboxing of ${p}: hands opening premium packaging, satisfying reveal, macro detail shots, soft studio lighting, clean aesthetic, no on-screen text.`,
    captionGuideAr: "هوك «شوفوا وش وصلنا» · تشويق الفتح · دعوة للحفظ/المتابعة للجديد.",
  },
  {
    key: "review", labelAr: "مراجعة (تعليق صوتي)", perWeek: 3, apiAudioSafe: true, defaultCta: "growth",
    promptEn: (p) => `Vertical 9:16, 12 seconds. A confident Gulf beauty creator holds and demonstrates ${p} to camera as if giving an honest voiceover review; warm flattering light, tight framing on the product, no on-screen text.`,
    captionGuideAr: "هوك مشكلة يحلّها المنتج · رأي صادق بفائدة · دعوة واضحة (اطلبيه).",
  },
  {
    key: "asmr", labelAr: "ASMR", perWeek: 2, apiAudioSafe: true, defaultCta: "growth",
    promptEn: (p) => `Vertical 9:16, 10 seconds. Pure ASMR of ${p}: gentle tapping, swatching and texture close-ups, macro lens, crisp original sound, calming premium mood, no on-screen text.`,
    captionGuideAr: "هوك حسّي هادئ · وصف الملمس/الإحساس · دعوة للحفظ.",
  },
];

// Doha (UTC+3) publish slots: lunch + evening peaks.
export const REEL_SLOTS_QATAR_H = [13, 20];
export const QATAR_UTC_OFFSET_H = 3;

/** UTC Date of (dayOffset, slot). Day 0 = tomorrow (never schedule into today). */
export function reelSlotUtc(from: Date, dayOffset: number, slot: number): Date {
  const hourQ = REEL_SLOTS_QATAR_H[Math.max(0, Math.min(REEL_SLOTS_QATAR_H.length - 1, slot))];
  const local = new Date(from.getTime() + QATAR_UTC_OFFSET_H * 3600_000);
  const base = Date.UTC(
    local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1 + dayOffset,
    hourQ - QATAR_UTC_OFFSET_H, 0, 0, 0,
  );
  return new Date(base);
}

/** 14 format keys, interleaved so the same format is rarely back-to-back. */
export function weeklyFormatSequence(): ReelFormatKey[] {
  const left = new Map(REEL_FORMATS.map((f) => [f.key, f.perWeek] as const));
  const seq: ReelFormatKey[] = [];
  let guard = 0;
  while (seq.length < REELS_PER_WEEK && guard++ < 1000) {
    for (const f of REEL_FORMATS) {
      const n = left.get(f.key) ?? 0;
      if (n > 0) {
        seq.push(f.key);
        left.set(f.key, n - 1);
        if (seq.length === REELS_PER_WEEK) break;
      }
    }
  }
  return seq;
}

export interface ReelPlanProduct {
  sku: string;
  name_en?: string | null;
  name_ar?: string | null;
}

export interface ReelPlanItem {
  index: number;
  dayOffset: number;
  slot: number;
  scheduledAtIso: string;
  format: ReelFormatKey;
  formatLabelAr: string;
  apiAudioSafe: boolean;
  sku: string | null;
  productName: string | null;
  promptEn: string;
  captionGuideAr: string;
  ctaType: CtaType;
}

/** Deterministic CTA: growth-only until conversionRatio > 0 (Phase 3 flips it). */
function ctaFor(f: ReelFormat, index: number, conversionRatio: number): CtaType {
  if (conversionRatio <= 0) return "growth";
  if (conversionRatio >= 1) return "conversion";
  const every = Math.max(1, Math.round(1 / conversionRatio));
  return index % every === 0 ? "conversion" : f.defaultCta;
}

/**
 * Build the week's 14-Reel plan. Products are rotated in the order given (the
 * caller sequences new-arrivals → bestsellers → Thailand batch). `from` anchors
 * the schedule (day 0 = tomorrow). conversionRatio in [0,1] mixes in conversion
 * CTAs; 0 = pure growth.
 */
export function buildWeeklyReelsPlan(
  products: ReelPlanProduct[],
  from: Date,
  opts: { conversionRatio?: number } = {},
): ReelPlanItem[] {
  const seq = weeklyFormatSequence();
  const ratio = opts.conversionRatio ?? 0;
  return seq.map((key, i) => {
    const f = REEL_FORMATS.find((x) => x.key === key)!;
    const dayOffset = Math.floor(i / REEL_SLOTS_QATAR_H.length);
    const slot = i % REEL_SLOTS_QATAR_H.length;
    const product = products.length ? products[i % products.length] : null;
    const name = product ? (product.name_en || product.name_ar || product.sku) : null;
    return {
      index: i, dayOffset, slot,
      scheduledAtIso: reelSlotUtc(from, dayOffset, slot).toISOString(),
      format: key, formatLabelAr: f.labelAr, apiAudioSafe: f.apiAudioSafe,
      sku: product?.sku ?? null, productName: name,
      promptEn: f.promptEn(name || "the product"),
      captionGuideAr: f.captionGuideAr,
      ctaType: ctaFor(f, i, ratio),
    };
  });
}
