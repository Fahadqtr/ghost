import type { VideoKind } from "./routing";

// Reusable video templates. A template = a named look (prompt + which kind of
// video it is). More templates can be added here without touching the engine.

export interface VideoTemplate {
  id: string;
  labelAr: string;
  labelEn: string;
  kind: VideoKind;      // routes to the right provider (product → FLORA)
  prompt: string;       // motion/style prompt (used when the provider accepts one)
  previewDurationSec: number;
}

export const VIDEO_TEMPLATES: VideoTemplate[] = [
  {
    id: "luxury_beauty_reel",
    labelAr: "ريل تجميل فاخر",
    labelEn: "Luxury Beauty Reel",
    kind: "luxury_product_ad",
    prompt:
      "Luxury beauty product commercial. Slow cinematic push-in on the product. Keep the product EXACTLY as in the image — identical shape, logo, label, printed text, colours and proportions; no morphing, no extra objects, no distortion. Soft studio lighting, elegant reflective surface, shallow depth of field, premium beauty-ad look, vertical 9:16.",
    previewDurationSec: 5,
  },
];

export const DEFAULT_TEMPLATE_ID = "luxury_beauty_reel";

export function videoTemplate(id: string | null | undefined): VideoTemplate | undefined {
  return VIDEO_TEMPLATES.find((t) => t.id === id);
}
