// Pure shot planner for the Final Reel. A real ad is several DIFFERENT shots of
// the same product cut together — not one clip looped. This defines the default
// shot list (hero → detail/motion → [lifestyle] → CTA) and the motion prompt for
// each. DB/API-free so it can be unit-tested.

export type ShotKey = "hero" | "detail" | "lifestyle" | "cta";

export interface ShotSpec {
  key: ShotKey;
  labelAr: string;
  labelEn: string;
  prompt: string;         // motion/style prompt sent to FLORA (product identity locked)
}

// Every shot keeps the product identical to the source image — the beauty-ad
// look only changes the camera/lighting/framing, never the product itself.
const IDENTITY =
  "Keep the product EXACTLY as in the image — identical shape, logo, label, printed text, colours and proportions; no morphing, no extra objects, no distortion. Vertical 9:16, premium beauty-ad look.";

const SHOTS: Record<ShotKey, ShotSpec> = {
  hero: {
    key: "hero", labelAr: "لقطة البطل", labelEn: "Hero shot",
    prompt: `Opening hero shot: slow cinematic push-in on the product, soft premium studio lighting, elegant reflective surface, shallow depth of field. ${IDENTITY}`,
  },
  detail: {
    key: "detail", labelAr: "لقطة التفاصيل/الحركة", labelEn: "Detail / motion shot",
    prompt: `Detail motion shot: gentle close macro pan across the product's texture, label and finish with a subtle rotation that shows quality. ${IDENTITY}`,
  },
  lifestyle: {
    key: "lifestyle", labelAr: "لقطة أجواء", labelEn: "Lifestyle shot",
    prompt: `Lifestyle shot: the product resting on a warm elegant vanity with soft daylight and gentle bokeh, calm aspirational skincare-routine mood. ${IDENTITY}`,
  },
  cta: {
    key: "cta", labelAr: "لقطة الختام", labelEn: "Final / CTA shot",
    prompt: `Closing shot: product centered and glowing, camera slowly settles into a clean elegant frame with breathing room for a call-to-action, luxurious finish. ${IDENTITY}`,
  },
};

export const MIN_SHOTS = 3;
export const MAX_SHOTS = 4;

/**
 * How many distinct shots to generate for a given voiceover length. 3 shots
 * (~3–5s each) cover most reels; a longer voiceover gets a 4th shot instead of
 * an obvious loop.
 */
export function shotCountForDuration(voiceSec?: number | null): number {
  const v = Number(voiceSec) || 0;
  return v > 13 ? MAX_SHOTS : MIN_SHOTS;
}

/**
 * The ordered shot list for a reel. 3 → hero, detail, cta. 4 → hero, detail,
 * lifestyle, cta. Always opens on the hero and ends on the CTA shot.
 */
export function planReelShots(count = MIN_SHOTS): ShotSpec[] {
  const n = Math.max(MIN_SHOTS, Math.min(MAX_SHOTS, Math.round(count) || MIN_SHOTS));
  const middle: ShotKey[] = n >= 4 ? ["detail", "lifestyle"] : ["detail"];
  return ["hero", ...middle, "cta"].map((k) => SHOTS[k as ShotKey]);
}
