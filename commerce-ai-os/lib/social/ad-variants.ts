// Ad design variants — pure, DOM-free.
//
// Each variant is a full art direction: an overlay palette (panel, ink, gold,
// CTA) + a matching English scene brief for the AI background. The variant is
// picked from the product id (stable per product) and rotates on every extra
// tap, so different products get different looks and re-taps give fresh ones.

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
  scene: string; // English scene brief handed to the image model (no text!)
}

const SCENE_BASE =
  "Ultra-realistic LUXURY beauty campaign photo, editorial 8K quality. " +
  "The uploaded product is the SOURCE OF TRUTH: do NOT redesign, recreate, replace or invent any part of it, its " +
  "packaging, its label or any lettering on it — preserve every visible detail exactly; the ONLY allowed changes are " +
  "lighting, shadows, background and camera angle. Keep it the hero, sharp focus, occupying about 40-50% of the frame. " +
  "COMPOSITION: place the product toward the RIGHT side and keep the LEFT ~45% as clean EMPTY background for text " +
  "added later; generous breathing room, extremely clean, no clutter. Photorealistic. " +
  "CRITICAL: do NOT add ANY new text, captions, labels, prices, buttons, icons, typography, UI or graphics. ";

export const AD_VARIANTS: AdVariant[] = [
  {
    key: "cream-gold",
    palette: { ink: "#38291b", muted: "#8c7a66", gold: "#b0894f", dark: "#2c2013", panel: "247,240,230" },
    scene: SCENE_BASE + "Setting: warm beige/ivory/cream palette, soft flowing silk fabric, natural sunlight from one side, a marble or travertine podium, premium spa atmosphere.",
  },
  {
    key: "blush-rose",
    palette: { ink: "#4a2e33", muted: "#a07d84", gold: "#c08d7c", dark: "#3a2226", panel: "250,240,238" },
    scene: SCENE_BASE + "Setting: soft blush pink and rose-beige palette, delicate rose petals, satin fabric folds, gentle morning light, a polished rose-marble surface, romantic luxury mood.",
  },
  {
    key: "sage-botanical",
    palette: { ink: "#2f3a2c", muted: "#7d8a76", gold: "#8f9d6b", dark: "#232d20", panel: "241,244,235" },
    scene: SCENE_BASE + "Setting: sage green and warm ivory palette, fresh botanical leaves and soft shadows of foliage, natural daylight, a light stone pedestal, clean organic spa mood.",
  },
  {
    key: "sand-bronze",
    palette: { ink: "#3b2c1a", muted: "#93805f", gold: "#a9803e", dark: "#2b2113", panel: "245,238,224" },
    scene: SCENE_BASE + "Setting: golden sand and bronze palette, sculptural sand dunes texture or travertine blocks, warm sunset side light with long soft shadows, desert-luxury editorial mood.",
  },
  {
    key: "ivory-noir",
    palette: { ink: "#26211c", muted: "#84796d", gold: "#a68d5c", dark: "#1c1712", panel: "244,241,236" },
    scene: SCENE_BASE + "Setting: minimal ivory and charcoal palette, dramatic single-source studio light, glossy dark stone surface with elegant reflections, high-contrast chic editorial mood.",
  },
];

/** Small stable hash so the same product starts from the same variant. */
export function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h;
}

/** Variant for a product: stable on the first tap, rotates on every re-tap. */
export function pickVariant(seed: string, tap = 0): AdVariant {
  return AD_VARIANTS[(hashSeed(String(seed)) + tap) % AD_VARIANTS.length];
}
