// Pure helpers for the "professional reel" request queue (Higgsfield Marketing
// Studio talking-avatar UGC). DB/API-free so it can be unit-tested.

export interface ReelStyle {
  slug: string;   // Marketing Studio mode slug
  labelAr: string;
  labelEn: string;
}

// The Marketing Studio modes that fit a beauty store's talking-avatar reels.
export const REEL_STYLES: ReelStyle[] = [
  { slug: "ugc_gadget_saved_me", labelAr: "توصية: غيّر روتيني", labelEn: "This gadget saved me" },
  { slug: "ugc_direct_to_camera", labelAr: "تتكلم للكاميرا", labelEn: "Direct to camera" },
  { slug: "ugc", labelAr: "UGC واقعي", labelEn: "Realistic UGC" },
  { slug: "ugc_selfie_testimonial", labelAr: "شهادة سيلفي", labelEn: "Selfie testimonial" },
  { slug: "ugc_before_and_after", labelAr: "قبل و بعد", labelEn: "Before & after" },
  { slug: "ugc_unboxing", labelAr: "فتح علبة", labelEn: "Unboxing" },
  { slug: "ugc_how_to", labelAr: "طريقة الاستخدام", labelEn: "Tutorial" },
  { slug: "product_showcase", labelAr: "عرض المنتج", labelEn: "Product showcase" },
];

export function styleLabelAr(slug: string | null | undefined): string {
  const s = REEL_STYLES.find((x) => x.slug === slug);
  return s ? s.labelAr : (slug || "UGC");
}

const STORE_DOMAIN = "malikasuniverse.com";

/** Storefront search URL for a SKU (product deep-link isn't always known). */
export function reelProductUrl(sku: string | null | undefined): string {
  return sku ? `https://${STORE_DOMAIN}/search?q=${encodeURIComponent(sku)}` : `https://${STORE_DOMAIN}`;
}

export interface ReelBriefInput {
  productName?: string | null;
  sku?: string | null;
  style?: string | null;
  notes?: string | null;
  script?: string | null;
  scheduledAtIso?: string | null;
}

/** User prompt for Claude to draft a short Gulf-Arabic VO script for the reel. */
export function buildScriptPrompt(input: { productName?: string | null; style?: string | null; notes?: string | null; priceQar?: number | null }): string {
  const name = String(input.productName || "the product").trim();
  const style = REEL_STYLES.find((x) => x.slug === input.style);
  const notes = String(input.notes || "").trim();
  return [
    `Write the spoken voiceover script for a ${style ? style.labelEn : "UGC"} Instagram reel advertising «${name}»${input.priceQar != null ? ` (price ${input.priceQar} QAR)` : ""} for the Qatari beauty store Malika's Universe.`,
    `Rules:`,
    `- Exactly 4 short lines, one per scene, in NATURAL QATARI GULF ARABIC (Khaleeji) — spoken, warm, like a real Doha influencer. Not MSA, not formal.`,
    `- Total ~30 words. Each line must be easy to pronounce clearly; avoid English letters, product codes, numbers, or hard abbreviations in the spoken lines.`,
    `- Line 1 = a relatable hook/problem. Line 2 = introduce the product as the fix. Line 3 = how she uses it / the benefit. Line 4 = a warm CTA ending with: اطلبيه من ماليكاز يونيفرس، توصيل لكل قطر.`,
    notes ? `- Owner direction: ${notes}` : ``,
    `Return ONLY the 4 lines, each on its own line, no numbering, no quotes, no extra text.`,
  ].filter(Boolean).join("\n");
}

/**
 * A copy-paste brief describing exactly what reel to generate — product, style,
 * spoken language, and any owner notes. Handed to whoever runs Marketing Studio.
 */
export function buildReelBrief(input: ReelBriefInput): string {
  const name = String(input.productName || input.sku || "the product").trim();
  const style = REEL_STYLES.find((x) => x.slug === input.style);
  const lines = [
    `Marketing Studio reel — ${name}${input.sku ? ` (SKU ${input.sku})` : ""}`,
    `Product URL: ${reelProductUrl(input.sku)}`,
    `Style: ${style ? style.labelEn : input.style || "Realistic UGC"} (${input.style || "ugc"})`,
    `Format: vertical 9:16, ~15s, audio on, resolution 720p.`,
    `Spoken language: natural Gulf Arabic (Khaleeji). End with a warm CTA: order from Malika's Universe, delivery across Qatar.`,
  ];
  const script = String(input.script || "").trim();
  if (script) {
    lines.push(
      `Spoken script — the avatar must say these EXACT lines VERBATIM in clear Qatari Gulf Arabic (do not paraphrase, translate, or read codes/English aloud):`,
      script,
    );
  }
  const notes = String(input.notes || "").trim();
  if (notes) lines.push(`Owner notes: ${notes}`);
  if (input.scheduledAtIso) lines.push(`Schedule for: ${input.scheduledAtIso}`);
  return lines.join("\n");
}
