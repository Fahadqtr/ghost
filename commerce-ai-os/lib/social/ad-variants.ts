// Ad design variants — pure, DOM-free.
//
// Two independent axes of art direction:
//   • VARIANT (palette + backdrop mood) — 5 options
//   • LAYOUT (where product/copy live)  — 3 options
// Both are picked from the product id (stable per product) and rotate on every
// extra tap. 5 and 3 are coprime, so consecutive taps walk through all 15
// palette×layout combinations before repeating.

export interface AdPalette {
  ink: string;    // primary text
  muted: string;  // secondary text
  gold: string;   // accent (icons, hairlines, price label)
  dark: string;   // CTA pill
  panel: string;  // opaque copy-panel color as "r,g,b"
}

export interface AdVariant {
  key: string;
  palette: AdPalette;
  setting: string; // English mood clause appended to the backdrop brief
}

export type AdLayoutKey = "panel" | "hero" | "banner";

export interface AdLayout {
  key: AdLayoutKey;
  composition: string; // where the backdrop must stay clean for this layout
}

// EMPTY backdrop brief: the model paints scenery ONLY — the real product photo
// is composited on top later, untouched, so packaging/labels can never break.
const SCENE_BASE =
  "Ultra-realistic EMPTY luxury beauty backdrop photo, editorial 8K quality, vertical 4:5 composition. " +
  "The scene must be COMPLETELY EMPTY: absolutely NO products, bottles, jars, tubes, boxes, packaging or any object " +
  "that could look like a beauty product; NO people, faces, hands or models; NO text, letters, logos, watermarks, " +
  "icons or graphics of any kind. Soft natural shadows, realistic photography, no clutter, no neon colors, " +
  "no dark background. ";

export const AD_LAYOUTS: AdLayout[] = [
  {
    key: "panel",
    composition:
      "COMPOSITION: on the RIGHT side, a softly lit low stone/marble pedestal or clean surface with a BRIGHT, nearly " +
      "white, softly glowing zone (a real product photo will be composited there later); the LEFT ~45% stays smooth, " +
      "clean and uncluttered for marketing text. ",
  },
  {
    key: "hero",
    composition:
      "COMPOSITION: a softly lit low pedestal or clean surface in the CENTER with a BRIGHT, nearly white, softly " +
      "glowing zone in the middle of the frame (a real product photo will be composited there later); the TOP third " +
      "and BOTTOM quarter stay smooth, clean and uncluttered for marketing text. ",
  },
  {
    key: "banner",
    composition:
      "COMPOSITION: a softly lit clean surface in the UPPER-CENTER with a BRIGHT, nearly white, softly glowing zone " +
      "there (a real product photo will be composited there later); the BOTTOM ~40% stays smooth, simple and " +
      "uncluttered (a solid text panel will cover it). ",
  },
];

export const AD_VARIANTS: AdVariant[] = [
  {
    key: "cream-gold",
    palette: { ink: "#38291b", muted: "#8c7a66", gold: "#b0894f", dark: "#2c2013", panel: "247,240,230" },
    setting: "Setting: warm beige/ivory/cream palette, soft flowing silk fabric, natural sunlight from one side, a marble or travertine podium, premium spa atmosphere.",
  },
  {
    key: "blush-rose",
    palette: { ink: "#4a2e33", muted: "#a07d84", gold: "#c08d7c", dark: "#3a2226", panel: "250,240,238" },
    setting: "Setting: soft blush pink and rose-beige palette, delicate rose petals, satin fabric folds, gentle morning light, a polished rose-marble surface, romantic luxury mood.",
  },
  {
    key: "sage-botanical",
    palette: { ink: "#2f3a2c", muted: "#7d8a76", gold: "#8f9d6b", dark: "#232d20", panel: "241,244,235" },
    setting: "Setting: sage green and warm ivory palette, fresh botanical leaves and soft shadows of foliage, natural daylight, a light stone pedestal, clean organic spa mood.",
  },
  {
    key: "sand-bronze",
    palette: { ink: "#3b2c1a", muted: "#93805f", gold: "#a9803e", dark: "#2b2113", panel: "245,238,224" },
    setting: "Setting: golden sand and bronze palette, sculptural sand dunes texture or travertine blocks, warm sunset side light with long soft shadows, desert-luxury editorial mood.",
  },
  {
    key: "ivory-noir",
    palette: { ink: "#26211c", muted: "#84796d", gold: "#a68d5c", dark: "#1c1712", panel: "244,241,236" },
    setting: "Setting: minimal ivory palette with subtle charcoal accents, dramatic single-source studio light, light polished stone surface with elegant soft reflections, chic editorial mood.",
  },
];

/** Small stable hash so the same product starts from the same variant. */
export function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h;
}

/** Palette/mood variant: stable per product, rotates on every re-tap. */
export function pickVariant(seed: string, tap = 0): AdVariant {
  return AD_VARIANTS[(hashSeed(String(seed)) + tap) % AD_VARIANTS.length];
}

/** Layout: same rotation rule; 5×3 coprime → 15 unique combos per product. */
export function pickLayout(seed: string, tap = 0): AdLayout {
  return AD_LAYOUTS[(hashSeed(String(seed)) + tap) % AD_LAYOUTS.length];
}

/** The full backdrop brief for one (variant, layout) pair. */
export function buildSceneBrief(variant: AdVariant, layout: AdLayout): string {
  return SCENE_BASE + layout.composition + variant.setting;
}

/**
 * Product-refinement brief: turn a messy supplier photo (collage grids, gray
 * backgrounds, hands, models) into ONE clean professional studio shot of the
 * SAME product — identical shape/colors/label — on a seamless near-white
 * background so it multiply-melts into the luxury backdrop.
 */
export const PRODUCT_REFINE_PROMPT =
  "Professional studio product photograph. From this photo, isolate THE MAIN PRODUCT only and re-photograph it " +
  "alone on a seamless pure WHITE background. The product must stay IDENTICAL: same shape, proportions, materials, " +
  "colors, and its own printed label/text exactly as-is (do not redraw, translate or invent any lettering). " +
  "REMOVE everything else: collage panels, grid layouts, gray or colored backgrounds, hands, faces, people, props " +
  "and duplicate views — show the product ONCE, large and centered. Soft even studio lighting, a gentle natural " +
  "shadow under the product, razor-sharp focus, high-end e-commerce quality. " +
  "Do NOT add any new text, logos, watermarks, graphics or extra objects.";
