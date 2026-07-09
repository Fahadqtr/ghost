// Story-ad prompt core — pure, network-free.
//
// Builds the single rich prompt handed to Gemini/gpt-image-1 to generate a
// full VERTICAL 9:16 Instagram STORY from the uploaded beauty product: scene +
// product + elegant Arabic headline + CTA, sized for the story canvas. Kept
// pure so the prompt shape is unit-tested; the model call lives in the action.

export interface StoryAdInput {
  nameAr?: string | null;
  nameEn?: string | null;
  description?: string | null;
  price?: string | null; // already formatted, e.g. "78 ر.ق" ("" → no badge)
}

const clip = (s: unknown, max: number): string =>
  String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** The luxury vertical-story instruction (English directions, Arabic content). */
export function buildStoryAdPrompt(input: StoryAdInput): string {
  const nameAr = clip(input.nameAr, 120);
  const nameEn = clip(input.nameEn, 120);
  const desc = clip(input.description, 400);
  const price = clip(input.price, 40);
  const nameLine = [nameAr, nameEn].filter(Boolean).join(" / ") || "the uploaded product";

  return (
    "Create an ultra-premium VERTICAL 9:16 (1080x1920) Instagram STORY using the uploaded beauty product.\n\n" +
    "BRAND — render at the top in elegant type:\nMALIKA'S\nUNIVERSE BEAUTY\n\n" +
    "STYLE: luxury, minimalist, editorial beauty campaign like Rhode, Dior Beauty, Chanel Beauty and Aesop. " +
    "Warm beige, ivory, cream, champagne, soft brown and subtle gold palette.\n\n" +
    "LAYOUT for a phone story: keep all text and the product SAFELY inside the central area — leave generous empty " +
    "margins at the very top and very bottom so nothing is hidden behind the Instagram profile bar or the reply " +
    "bar. Product as the hero in the middle, text stacked in the lower third.\n\n" +
    "SCENE: an elegant travertine or soft-fabric setting, warm golden sunlight from one side, soft realistic " +
    "shadows, a clean luxury spa atmosphere, high-end studio lighting, lots of negative space.\n\n" +
    "PRODUCT: use ONLY the uploaded product; preserve its exact packaging, colours, logo and proportions; make it " +
    "the hero; photorealistic and ultra-sharp.\n\n" +
    `PRODUCT CONTEXT (write the Arabic copy about THIS): ${nameLine}.` + (desc ? ` Notes: ${desc}.` : "") + "\n\n" +
    "TYPOGRAPHY — render in ELEGANT, CORRECT, MODERN ARABIC (fully shaped, no broken or mirrored letters):\n" +
    "- a powerful large luxury Arabic marketing headline;\n" +
    "- one short premium Arabic line about the product;\n" +
    (price
      ? `- a luxury rounded price badge showing the label «سعر خاص» above the price «${price}»;\n`
      : "- (no price badge);\n") +
    "- a luxury rounded dark CTA button with the exact Arabic text «اطلبيه الآن».\n\n" +
    "RULES: ultra clean, premium, editorial, soft luxury colour grading, perfect spacing, photorealistic, 8K, no " +
    "clutter, no watermark, and absolutely NO distorted Arabic text. It must look like it was designed by a luxury " +
    "beauty advertising agency."
  );
}
