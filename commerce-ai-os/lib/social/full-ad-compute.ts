// Full-ad prompt core — pure, network-free.
//
// Builds the single rich prompt handed to gpt-image-1 to generate the ENTIRE
// luxury ad in one shot: scene + product + elegant Arabic typography + icons +
// price badge + CTA + footer. gpt-image-1 now renders Arabic cleanly, so we let
// it compose everything (no HTML overlay). Kept pure so the prompt shape is
// unit-tested; the OpenAI call lives in editProductImageCore (raw mode).

export interface FullAdInput {
  nameAr?: string | null;
  nameEn?: string | null;
  description?: string | null;
  price?: string | null; // already formatted, e.g. "78 ر.ق" ("" → no badge)
}

const clip = (s: unknown, max: number): string =>
  String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** The luxury full-ad instruction (English directions, Arabic content). */
export function buildFullAdPrompt(input: FullAdInput): string {
  const nameAr = clip(input.nameAr, 120);
  const nameEn = clip(input.nameEn, 120);
  const desc = clip(input.description, 500);
  const price = clip(input.price, 40);
  const nameLine = [nameAr, nameEn].filter(Boolean).join(" / ") || "the uploaded product";

  return (
    "Create an ultra-premium square 1080x1080 Instagram advertisement using the uploaded beauty product.\n\n" +
    "BRAND — render at the top in elegant type:\nMALIKA'S\nUNIVERSE BEAUTY\n\n" +
    "STYLE: luxury, minimalist, editorial beauty campaign like Rhode, Dior Beauty, Chanel Beauty, Hourglass and Aesop. " +
    "Warm beige, ivory, cream, champagne, soft brown and subtle gold palette.\n\n" +
    "SCENE: an elegant marble or travertine pedestal, soft flowing fabric in the background, warm golden sunlight from " +
    "one side, soft realistic shadows, a clean luxury spa atmosphere, high-end studio lighting, and lots of negative " +
    "space on the LEFT for the text.\n\n" +
    "PRODUCT: use ONLY the uploaded product; preserve its exact packaging, colours, logo and proportions; make it the " +
    "hero; photorealistic and ultra-sharp. You may add 1–2 extra copies only if it improves the composition.\n\n" +
    `PRODUCT CONTEXT (write the Arabic copy about THIS): ${nameLine}.` + (desc ? ` Notes: ${desc}.` : "") + "\n\n" +
    "TYPOGRAPHY — render in ELEGANT, CORRECT, MODERN ARABIC (fully shaped, no broken or mirrored letters), laid " +
    "cleanly over the left negative space:\n" +
    "- a short premium Arabic intro line about the product;\n" +
    "- a powerful large luxury Arabic marketing headline;\n" +
    "- 4–5 short premium Arabic benefits, each with a small elegant outline icon;\n" +
    (price
      ? `- a luxury rounded price badge showing the label «سعر خاص» above the price «${price}»;\n`
      : "- (no price badge);\n") +
    "- a luxury rounded dark CTA button with the exact Arabic text «اطلبيه الآن»;\n" +
    "- a minimal footer bar with 3 short Arabic features and elegant outline icons.\n\n" +
    "RULES: ultra clean, premium, editorial, soft luxury colour grading, perfect spacing, photorealistic, 8K, no " +
    "clutter, no watermark, and absolutely NO distorted Arabic text. It must look like it was designed by a luxury " +
    "beauty advertising agency for an international cosmetics brand."
  );
}
