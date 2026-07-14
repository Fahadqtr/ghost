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

// ── Consistency + guardrails baked into every generation brief ──────────────
// These stop the recurring artefacts: product morphing, identity drift, extra
// objects, deformed hands, jumpy cuts. They're prompt-level controls — the only
// lever the Marketing-Studio path exposes (it has no seed/negative-prompt API).

/** STRICT MASTER references — product + character must stay identical shot-to-shot. */
export const REEL_MASTER_REFERENCE = [
  "STRICT MASTER PRODUCT REFERENCE: the product in every shot must be IDENTICAL to the source product image — same shape, colour, size, proportions, logo, printed text/label, device tip/head, body design, and cord. Never change, morph, re-letter, recolour, duplicate, or invent any part of the product.",
  "MASTER CHARACTER REFERENCE: the SAME woman in every shot — identical face, features, skin tone, approximate age, hijab/hair, clothing, makeup, background and overall lighting. Do not change her identity between shots.",
].join("\n");

/** The fixed 5-shot beauty structure (~2–3s each). */
export const REEL_SHOT_STRUCTURE = [
  "SHOT 1 (~3s): close-up of the same woman showing mild redness/blemishes/skin concern on her cheek; natural facial movement; she gently points to the problem area; identity perfectly consistent; NO product visible yet.",
  "SHOT 2 (~3s): smooth transition to a medium shot; the same woman presents the EXACT device from the master reference toward camera; device identical to source — no morphing, no changing logo/proportions.",
  "SHOT 3 (~3s): close-up of the same cheek; she carefully uses the exact same device with realistic controlled movement; device tip stays consistent; hand anatomically correct; NO new objects, NO serum dropper, NO product transformation.",
  "SHOT 4 (~3s): smooth beauty transition; the exact same woman with healthier, fresh, glowing skin; keep it realistic and believable; same environment, same styling; do not change her identity or over-smooth.",
  "SHOT 5 (~3s): final medium beauty shot; the same woman smiles naturally; the exact original product clearly visible beside her or in her hand; branding and design unchanged; luxury beauty-ad look.",
].join("\n");

/** Concise product-consistency suffix for the image→video (DoP) path, which
 *  animates the product photo directly and has no character/negative-prompt API. */
export const DOP_PRODUCT_SUFFIX =
  "Keep the product exactly as in the source image — same shape, colour, logo, printed text and proportions; do not morph, recolour, duplicate, add extra objects, or distort it. Only slow, gentle, cinematic camera motion.";

/** Camera + motion constraints. */
export const REEL_CAMERA =
  "Camera: only subtle push-in, slow cinematic movement, gentle handheld stabilization, controlled beauty motion. NO aggressive camera motion, no fast/random zoom, no extreme rotation, no sudden perspective changes, no random cuts — transitions must feel connected.";

/** Strong, fixed negative prompt applied to every shot. */
export const REEL_NEGATIVE_PROMPT = [
  "No serum dropper", "No extra cosmetic products", "No extra objects", "No changing product",
  "No product morphing", "No changing logo", "No changing text", "No changing device tip",
  "No duplicated product", "No extra hands", "No extra fingers", "No duplicated fingers",
  "No deformed hands", "No warped hands", "No distorted face", "No changing identity",
  "No changing hijab", "No changing clothes", "No random background changes", "No floating objects",
  "No melting objects", "No unrealistic anatomy", "No aggressive camera movement", "No sudden zoom",
  "No random cuts",
].join(", ");

/** User prompt for Claude to draft a short white-Gulf (Qatari) VO script. */
export function buildScriptPrompt(input: { productName?: string | null; style?: string | null; notes?: string | null; priceQar?: number | null }): string {
  const name = String(input.productName || "the product").trim();
  const style = REEL_STYLES.find((x) => x.slug === input.style);
  const notes = String(input.notes || "").trim();
  return [
    `Write, from scratch, the spoken voiceover for a ${style ? style.labelEn : "UGC"} Instagram beauty reel for «${name}»${input.priceQar != null ? ` (price ${input.priceQar} QAR)` : ""} for the Qatari store Malika's Universe.`,
    `DIALECT — this is the most important rule:`,
    `- Write NATIVELY in natural WHITE GULF ARABIC understood in Qatar (Khaleeji, close to Qatari). Feminine, soft, warm, confident — a real beauty influencer, NOT an ad robot.`,
    `- Do NOT write in Modern Standard Arabic (fus-ha) and do NOT mix dialects. NEVER Egyptian, Levantine, Moroccan, or heavy Iraqi. No dialect switching between sentences.`,
    `- Use Qatari feminine address where natural (e.g. بشرتج، روتينج، تقدرين، استخدميه).`,
    `PRONUNCIATION SAFETY:`,
    `- Every word must be easy for a text-to-speech voice to pronounce correctly. Avoid words known to break Arabic TTS, English letters, product codes, and numbers in the spoken lines.`,
    `- Refer to the device only as «دكتور بِن» (never read any code/English aloud).`,
    `- After drafting, RE-READ each word; if any word is hard to pronounce, replace it with a clearer Gulf synonym. Add light tashkeel only where it prevents a mispronunciation.`,
    `STRUCTURE: exactly 4 short lines, one per scene, ~30 words total. Line 1 = relatable skin-concern hook. Line 2 = introduce «دكتور بِن» as the fix. Line 3 = how she uses it (a professional step in her routine). Line 4 = warm CTA ending with: اطلبيه من متجر ماليكاز يونيفرس، توصيل لكل قطر.`,
    `Reference tone (rewrite, don't copy): «تعانين من آثار الحبوب ومشاكل البشرة؟ مع دكتور بِن، تقدرين تضيفين خطوة احترافية لروتين العناية ببشرتج. استخدميه بالطريقة المناسبة، وخلي روتينج أكثر عناية. دكتور بِن، لمسة احترافية لروتين بشرتج.»`,
    notes ? `Owner direction: ${notes}` : ``,
    `Return ONLY the 4 Arabic lines, each on its own line — no numbering, no quotes, no English, no extra text.`,
  ].filter(Boolean).join("\n");
}

/**
 * A copy-paste production brief for the reel — product, style, the STRICT master
 * references, the 5-shot structure, camera rules, the negative prompt, the exact
 * Gulf script, and subtitle guidance. Handed to whoever runs Marketing Studio.
 */
export function buildReelBrief(input: ReelBriefInput): string {
  const name = String(input.productName || input.sku || "the product").trim();
  const style = REEL_STYLES.find((x) => x.slug === input.style);
  const lines = [
    `Marketing Studio reel — ${name}${input.sku ? ` (SKU ${input.sku})` : ""}`,
    `Product URL: ${reelProductUrl(input.sku)}`,
    `Style: ${style ? style.labelEn : input.style || "Realistic UGC"} (${input.style || "ugc"})`,
    `Format: vertical 9:16, luxury beauty-ad look, ~15s, audio on, 720p. Realistic skin, smooth connected transitions.`,
    ``,
    REEL_MASTER_REFERENCE,
    ``,
    `Shot plan (build as 5 short connected beats, ~2–3s each, then assemble):`,
    REEL_SHOT_STRUCTURE,
    ``,
    REEL_CAMERA,
    ``,
    `Negative prompt (apply to every shot): ${REEL_NEGATIVE_PROMPT}.`,
    ``,
    `Voice: natural white Gulf Arabic (understood in Qatar), feminine, soft, confident — NOT MSA, NOT Egyptian/Levantine/Moroccan/Iraqi, no dialect mixing, no robotic tone, natural pauses, moderate pace. Pronounce «دكتور بِن» clearly.`,
  ];
  const script = String(input.script || "").trim();
  if (script) {
    lines.push(
      `Spoken script — say these EXACT lines VERBATIM in clear white Gulf Arabic (do not paraphrase, translate, add, shorten, or read any code/English aloud):`,
      script,
      `Subtitles: clean Arabic captions matching the audio word-for-word; correct spelling; safe margins for 9:16; do not cover the product or the face.`,
    );
  }
  const notes = String(input.notes || "").trim();
  if (notes) lines.push(``, `Owner notes: ${notes}`);
  if (input.scheduledAtIso) lines.push(`Schedule for: ${input.scheduledAtIso}`);
  return lines.join("\n");
}
