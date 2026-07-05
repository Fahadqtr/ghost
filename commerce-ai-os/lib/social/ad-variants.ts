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
  composition: string;      // where an EMPTY backdrop must stay clean (legacy path)
  productPlacement: string; // where the product stands when Gemini places it IN the scene
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
      "white, softly glowing zone (a real product photo will be composited there later); the LEFT ~45% stays VERY " +
      "smooth, soft, evenly lit and low-detail — marketing text will be placed DIRECTLY on it. ",
    productPlacement:
      "PLACEMENT: the product stands ON a low stone/marble pedestal on the RIGHT side of the frame, about 40-45% of " +
      "the frame height, its top edge NO higher than 28% from the top. KEEP-OUT ZONES (must stay completely empty — " +
      "no part of the product, pedestal or props may enter them): the LEFT ~45% of the frame and the TOP 25%; they " +
      "stay VERY smooth, soft, evenly lit and low-detail — marketing text will be placed DIRECTLY on them. ",
  },
  {
    key: "hero",
    composition:
      "COMPOSITION: a softly lit low pedestal or clean surface in the CENTER with a BRIGHT, nearly white, softly " +
      "glowing zone in the middle of the frame (a real product photo will be composited there later); the TOP third " +
      "and BOTTOM quarter stay VERY smooth, soft, evenly lit and low-detail — marketing text will be placed DIRECTLY " +
      "on them. ",
    productPlacement:
      "PLACEMENT: the product stands ON a low pedestal in the CENTER of the frame, hero composition, occupying ONLY " +
      "the middle band between 38% and 76% of the frame height — its top edge NO higher than 38% from the top. " +
      "KEEP-OUT ZONES (must stay completely empty — no part of the product, pedestal or props may enter them): the " +
      "TOP 38% and the BOTTOM 24% of the frame; they stay VERY smooth, soft, evenly lit and low-detail — marketing " +
      "text will be placed DIRECTLY on them. ",
  },
  {
    key: "banner",
    composition:
      "COMPOSITION: a softly lit clean surface in the UPPER-CENTER with a BRIGHT, nearly white, softly glowing zone " +
      "there (a real product photo will be composited there later); the BOTTOM ~40% stays VERY smooth, soft, evenly " +
      "lit and low-detail — marketing text will be placed DIRECTLY on it. ",
    productPlacement:
      "PLACEMENT: the product stands ON a clean surface in the UPPER-CENTER of the frame, occupying ONLY the band " +
      "between 20% and 60% of the frame height — its top edge NO higher than 20% from the top. KEEP-OUT ZONES (must " +
      "stay completely empty — no part of the product, pedestal or props may enter them): the BOTTOM ~40% of the " +
      "frame and the TOP 18%; they stay VERY smooth, soft, evenly lit and low-detail — marketing text will be " +
      "placed DIRECTLY on them. ",
  },
];

/**
 * Brand chrome — matched to the MU monogram (pure black on ivory). All UI
 * elements (type, hairlines, icons, CTA) use this monochrome identity while
 * the SCENES keep rotating through the variant moods below.
 */
export const BRAND_PALETTE: AdPalette = {
  ink: "#161412",   // near-black brand text
  muted: "#6e6862", // soft warm gray
  gold: "#3a352f",  // charcoal accent (hairlines, icons, price label)
  dark: "#0f0e0d",  // CTA pill — logo black
  panel: "246,244,240", // ivory
};

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

// Product-IN-scene brief: Gemini places the EXACT product from the supplied
// photo into the luxury scene itself — standing on the pedestal, grounded with
// real contact shadow and lighting — so it never looks pasted or floating.
const PRODUCT_SCENE_BASE =
  "Ultra-realistic luxury beauty campaign photograph, editorial 8K quality, vertical 4:5 composition. " +
  "TASK: take the product from the provided photo and place THAT EXACT PRODUCT into the scene described below. " +
  "The product must remain 100% IDENTICAL: same shape, proportions, materials, colors, cap and its own printed " +
  "label/text exactly as-is — do not redraw, translate, invent or alter any lettering on it. LOOK CAREFULLY at " +
  "what the product actually IS before drawing: NEVER substitute it with a different object type — press-on " +
  "artificial nails must stay press-on nails (never become a polish bottle), a palette stays a palette, a kit/box " +
  "stays that kit/box with its real contents. Show it ONCE, large " +
  "and razor-sharp, professionally lit, standing NATURALLY with a soft grounded contact shadow and a subtle " +
  "reflection — it must NEVER look pasted, cut out or floating in the air. Discard the source photo's own " +
  "background, collage panels, hands and people. " +
  "Do NOT add ANY marketing text, captions, headlines, prices, buttons, icons, logos, watermarks or graphics " +
  "anywhere in the image. NO people, faces, hands or models. " +
  "CRITICAL FRAMING RULE: the placement below defines KEEP-OUT ZONES reserved for typography that will be added " +
  "later — the product must fit ENTIRELY inside its allowed band and never overlap a keep-out zone; if in doubt, " +
  "make the product SMALLER rather than letting it touch a reserved zone. ";

/** The full product-in-scene brief for one (variant, layout) pair. */
export function buildProductSceneBrief(variant: AdVariant, layout: AdLayout): string {
  return PRODUCT_SCENE_BASE + layout.productPlacement + variant.setting;
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
