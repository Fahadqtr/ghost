// Story scene brief — pure, network-free.
//
// The image model CANNOT render Arabic (it comes out as broken glyphs), so —
// exactly like the feed ad — we ask it for a TEXT-FREE vertical 9:16 scene with
// the product as the hero and an empty lower third, then the browser overlays
// the real Arabic headline + price + CTA with embedded fonts (see StoryTemplate).

export interface StorySceneInput {
  nameAr?: string | null;
  nameEn?: string | null;
}

const clip = (s: unknown, max: number): string =>
  String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Vertical story scene instruction. Product hero in the UPPER-MIDDLE, empty
 * airy LOWER THIRD reserved for the (later, real-font) text. ABSOLUTELY NO
 * text/letters/logos baked into the image — that is what the overlay is for.
 */
export function buildStorySceneBrief(input: StorySceneInput): string {
  const name = [clip(input.nameAr, 120), clip(input.nameEn, 120)].filter(Boolean).join(" / ");
  return (
    "Create an ultra-premium VERTICAL 9:16 (1080x1920) luxury beauty product photograph using the uploaded product" +
    (name ? ` (the product is: ${name})` : "") + ".\n\n" +
    "COMPOSITION: place the product as the hero in the UPPER HALF of a tall vertical frame; keep the ENTIRE " +
    "LOWER 45% calm, soft and almost empty (a clean surface, gentle shadow or soft fabric) — that bottom space is " +
    "reserved for a text card and must stay simple and uncluttered.\n\n" +
    "STYLE: editorial luxury beauty campaign like Rhode, Dior Beauty, Chanel Beauty and Aesop. Warm beige, ivory, " +
    "cream, champagne, soft brown and subtle gold palette, warm golden side light, soft realistic shadows, high-end " +
    "studio look, light and airy (never dark).\n\n" +
    "PRODUCT: use ONLY the uploaded product; preserve its exact packaging, colours, logo and proportions faithfully; " +
    "photorealistic and ultra-sharp; do NOT redraw or relabel it.\n\n" +
    "STRICT RULES: absolutely NO text, NO letters, NO words, NO numbers, NO logos, NO watermark and NO captions " +
    "anywhere in the image — it must be a clean wordless photograph. No extra people, no clutter, ordered and " +
    "minimal with generous negative space."
  );
}
